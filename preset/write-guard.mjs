/**
 * Workspace-write / wait guard (2026-11-01, hardened after adversarial review).
 *
 * Absorbed from dsh-superagent's `noWait` guard (`src/app/sessions.ts`): a
 * `ctx.tools.guard()` is the framework's order-independent denial point, the
 * only mechanism that can refuse a call *and* explain why. Lean uses it for the
 * one behaviour prompts could not fix: bash file mutations bypass `fs/observed`,
 * so a later `edit` fails with "file changed since it was read".
 *
 * Measured in session-example (672 steps, 646 calls): ~70% of file mutations
 * went through bash (29 × `python3 - <<PY` in-place replace, 2 × `cat >`,
 * `sed -i`), and exactly those writes bypass the read evidence `edit` needs.
 *
 * Adversarial review (2026-11-01) of the first text-scan version found:
 *   - quoted text mentioning `sed -i … src/x.ts` was blocked (it blocked the
 *     review script itself);
 *   - `cat > /tmp/script.sh <<EOF … sleep 5 … EOF` was blocked as a "sleep";
 *   - `node -e` / `python3 -c` writes were not caught at all;
 *   - `cd /tmp/x && cat > probe.js` was blocked because relative targets were
 *     resolved against the session workspace instead of the effective cwd;
 *   - multi-file `sed -i a.ts /tmp/b.ts` was allowed when the last operand was
 *     outside the workspace.
 * The implementation below tokenizes (quotes, escapes, heredoc bodies),
 * tracks `cd` per segment, and attaches heredocs to the command that owns them.
 * Known limits are listed at the bottom.
 *
 * Default policy since the 2026-11-01 rate review (middle state):
 *   - block: interpreter scripts (`python3 - <<PY`, `node -e`, …) that write an
 *     *existing* workspace file — the pattern that produced the stale-read
 *     failures and silent no-op patches;
 *   - allow: `sed -i`, `cat >`, `tee` on workspace files (one such block cost a
 *     round without evidence of damage: 4 `sed -i` and ~2 existing-file `cat >`
 *     in the measured session), and creating new files;
 *   - block: sleeps ≥ 30 s (the foreground wait cap already covers the rest).
 * `guardShellWrites: true` restores the strict rules; `allowNewFileWrites:
 * false` makes new files count as writes too.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

/** `~` expansion, so `~/repo/src/x.ts` is judged like its absolute form. */
const homeDir = () => {
  try {
    return homedir()
  } catch {
    return ''
  }
}

/** Source-ish suffixes worth protecting; logs, csv, images keep flowing through bash. */
const SOURCE_SUFFIX = /\.(?:[cm]?[jt]sx?|json|md|markdown|py|go|rs|css|scss|less|html?|ya?ml|toml|sql|sh|bash|zsh|java|kt|kts|swift|rb|php|c|h|cc|cpp|hpp|cs|vue|svelte|astro|ini|conf|cfg|lock)$/i

/** Paths that never belong to the workspace's read evidence. */
const TEMP_PREFIX = /^\/(?:tmp|private\/tmp|var\/folders|dev)(?:\/|$)/

/** Python/Node/Ruby style scripted file writes (mode strings, write helpers). */
const SCRIPT_WRITE = /(?:open\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][wax][b+]*['"]|\bwrite_text\s*\(|\bwrite_bytes\s*\(|\bwriteFileSync\s*\(|\bwriteFile\s*\(|\bfs\.promises\.writeFile|\bFile\.write\s*\(|\bIO\.write\b|\.open\s*\(\s*['"][wax])/

const IN_PLACE = /^(?:-[a-zA-Z]*i|--in-place)/

const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'ruby', 'perl', 'deno', 'bun', 'php'])

/** Words whose next word is their value (so `-e 's/x/y/'` is not a file operand). */
const FLAG_WITH_VALUE = new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length', '-i', '--in-place'])

const TEMP_MENTION = /(?:^|[\s'"=(:])\/(?:tmp|private\/tmp|var\/folders)(?:\/|[\s'"=;:]|$)/

export const WORKSPACE_WRITE_REASON = [
  'lean guard：这条命令在写工作区文件（in-place 编辑 / 重定向 / 脚本写入），已拦截。',
  '改用 `write`（新文件）或 `edit`（已有文件）完成改动：bash 写文件不更新 read 证据，',
  '之后的 edit 会以 `file has not been read` / `file changed since it was read` 拒绝，也没有 diff 可审。',
  '临时脚本、SQL、日志写到 /tmp（或 /private/var、/var/folders）不受限制。',
].join('')

export const SLEEP_REASON = [
  'lean guard：不要用 `sleep` 等（一个睡眠的 step 会挡住这一轮）。',
  '长命令用 `run_in_background: true` 异步跑，结束时结果会作为消息回来；',
  '要主动收取就先用 `tool_gateway` 调 `job_list` 拿到 `job_id`，再 `call` `job_output`（参数名就是 `job_id`，不是 `id`），不要用 sleep 轮询。',
].join('')

const normalize = (path) => {
  const parts = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

const resolveAgainst = (raw, workspace) => {
  let path = raw.trim()
  if (path.length === 0) return undefined
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1)
  }
  if (path.length === 0 || path === '&' || /^&\d+$/.test(path)) return undefined
  if (path.includes('$') || path.includes('`')) return undefined
  if (path === '~' || path.startsWith('~/')) path = `${homeDir()}${path.slice(1)}`
  if (path.startsWith('~')) return undefined
  if (!path.startsWith('/')) path = `${workspace}/${path}`
  return normalize(path)
}

const inWorkspace = (raw, base, root) => {
  const resolved = resolveAgainst(raw, base)
  if (resolved === undefined) return false
  if (TEMP_PREFIX.test(resolved)) return false
  return resolved === root || resolved.startsWith(`${root}/`)
}

/**
 * A workspace target that does not exist yet: creating it cannot invalidate any
 * read evidence, so by default the guard lets bash create it (2026-11-01, after
 * the block rate measured 20.1% and most of it was new probe scripts). Existing
 * files keep the strict rule; `guardNewFileWrites: true` restores it for new ones.
 */
const isNewFile = (raw, base) => {
  const resolved = resolveAgainst(raw, base)
  if (resolved === undefined) return false
  if (TEMP_PREFIX.test(resolved)) return false
  try {
    return !existsSync(resolved)
  } catch {
    return false
  }
}

/**
 * Shell-aware scan.
 *   segments  — { words, heredocs } simple commands, in textual order
 *   redirects — { target, owner } redirection targets and the segment they belong to
 */
const scan = (command) => {
  const segments = []
  const redirects = []
  let words = []
  let word = ''
  let quote = null
  let i = 0

  const flushWord = () => {
    if (word.length > 0) {
      words.push(word)
      word = ''
    }
  }
  const flushSegment = () => {
    flushWord()
    if (words.length > 0) {
      segments.push({ words, heredocs: [] })
      words = []
    }
  }
  const readWord = (start) => {
    let j = start
    let value = ''
    let q = null
    while (j < command.length) {
      const c = command[j]
      if (q !== null) {
        if (c === q) q = null
        else value += c
        j += 1
        continue
      }
      if (c === "'" || c === '"') {
        q = c
        j += 1
        continue
      }
      if (c === '\\') {
        value += command[j + 1] ?? ''
        j += 2
        continue
      }
      if (/[\s;|&<>()]/.test(c)) break
      value += c
      j += 1
    }
    return { value, next: j }
  }

  while (i < command.length) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      else word += ch
      i += 1
      continue
    }
    if (ch === '\\') {
      word += command[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '<' && command[i + 1] === '<') {
      let j = i + 2
      const stripTabs = command[j] === '-'
      if (stripTabs) j += 1
      while (command[j] === ' ' || command[j] === '\t') j += 1
      const delimiter = readWord(j)
      const lineEnd = command.indexOf('\n', delimiter.next)
      let body = ''
      let after = command.length
      if (lineEnd >= 0) {
        const rest = command.slice(lineEnd + 1)
        // Closing line: exact delimiter, or (for `<<-`) the delimiter after
        // leading tabs. Scanning lines avoids the `\n<delim>` prefix trap.
        let offset = 0
        let close = -1
        while (offset <= rest.length) {
          const newline = rest.indexOf('\n', offset)
          const line = newline < 0 ? rest.slice(offset) : rest.slice(offset, newline)
          const candidate = stripTabs ? line.replace(/^\t+/, '') : line
          if (candidate === delimiter.value) {
            close = offset
            break
          }
          if (newline < 0) break
          offset = newline + 1
        }
        if (close >= 0) {
          body = rest.slice(0, close)
          after = lineEnd + 1 + close + (rest.slice(close).split('\n')[0]?.length ?? 0)
          if (command[after] === '\n') after += 1
        } else {
          body = rest
          after = command.length
        }
      }
      flushSegment()
      if (segments.length === 0) segments.push({ words: [], heredocs: [] })
      segments[segments.length - 1].heredocs.push(body)
      i = after
      continue
    }
    if (ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      const owner = segments.length
      flushSegment()
      let j = i + 1
      if (command[j] === '>') j += 1
      while (command[j] === ' ' || command[j] === '\t') j += 1
      const target = readWord(j)
      if (target.value.length > 0) redirects.push({ target: target.value, owner })
      i = target.next
      continue
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '(' || ch === ')' || ch === '\n') {
      flushSegment()
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flushWord()
      i += 1
      continue
    }
    word += ch
    i += 1
  }
  flushSegment()
  return { segments, redirects }
}

const baseName = (word) => word.split('/').pop() ?? word

/**
 * Does a script body write to a workspace source file?
 * Only *write* call targets count, so a read-only mention of a workspace path
 * (`s = open("src/x.ts").read(); open("/tmp/out.json","w")`) stays allowed.
 */
const writesWorkspace = (body, here, root, allowNewFileWrites) => {
  const literals = [
    ...body.matchAll(/\bopen\s*\(\s*['"]([^'"\n]{1,300})['"]\s*,\s*(?:mode\s*=\s*)?['"][wax]/g),
    ...body.matchAll(/\bwriteFileSync\s*\(\s*['"]([^'"\n]{1,300})['"]/g),
    ...body.matchAll(/\bwriteFile\s*\(\s*['"]([^'"\n]{1,300})['"]/g),
    ...body.matchAll(/\bPath\s*\(\s*['"]([^'"\n]{1,300})['"]\s*\)\s*\.write_(?:text|bytes)/g),
    ...body.matchAll(/\bFile\.write\s*\(\s*['"]([^'"\n]{1,300})['"]/g),
  ].map(match => match[1])
  if (literals.some(target => inWorkspace(target, here, root) && !(allowNewFileWrites && isNewFile(target, here)))) {
    return true
  }
  // A variable target (`p = "..."; open(p, "w")`): the path is assigned nearby.
  if (!/\bopen\s*\(\s*[A-Za-z_]\w*\s*,\s*(?:mode\s*=\s*)?['"][wax]/.test(body)) return false
  const quoted = [...body.matchAll(/['"]([^'"\n]{1,300})['"]/g)].map(match => match[1])
  return quoted.some(target => (
    SOURCE_SUFFIX.test(target)
    && inWorkspace(target, here, root)
    && !(allowNewFileWrites && isNewFile(target, here))
  ))
}

/** Operands of an in-place editor run, skipping flags and their values. */
const inPlaceOperands = (words) => {
  const operands = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (IN_PLACE.test(baseName(word))) continue
    if (FLAG_WITH_VALUE.has(word)) {
      index += 1
      continue
    }
    if (word.startsWith('-')) continue
    if (/^s[^a-zA-Z0-9]/.test(word) || (word.startsWith('/') && word.endsWith('/') && word.length > 1)) continue
    operands.push(word)
  }
  return operands
}

/** The tail of an in-place editor run anywhere in a segment (`xargs sed -i`). */
const inPlaceEditor = (words) => {
  for (let index = 0; index < words.length; index += 1) {
    if (!['sed', 'perl', 'ruby'].includes(baseName(words[index]))) continue
    const rest = words.slice(index + 1)
    if (rest.some(word => IN_PLACE.test(baseName(word)))) return rest
  }
  return undefined
}

/** Seconds a literal `sleep` argument asks for, or undefined when not literal. */
const sleepSeconds = (word) => {
  if (typeof word !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(word)
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = match[2]
  return unit === 'm' ? value * 60 : unit === 'h' ? value * 3600 : value
}

/** Why a shell command must not sleep, or undefined when it may. */
export const sleepGuardReason = (command) => {
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  // Segment-based: a `sleep` word inside a quoted argument (`echo "a && sleep 1"`,
  // `node -e "…sleep…"`) is data, not a command. Short literal pacing sleeps
  // (`sleep 1` between an API write and its read-back) stay allowed; the policy
  // targets waits long enough to hold the step.
  const WRAPPERS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', 'exec', 'nohup', 'command', 'env', 'sudo', '{', '!'])
  const MIN_BLOCKED_SECONDS = 30
  const { segments } = scan(command)
  for (const { words } of segments) {
    let index = 0
    while (index < words.length && (WRAPPERS.has(words[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1
    if (baseName(words[index] ?? '') !== 'sleep') continue
    const seconds = sleepSeconds(words[index + 1])
    if (seconds === undefined) return SLEEP_REASON
    if (seconds >= MIN_BLOCKED_SECONDS) return SLEEP_REASON
  }
  return undefined
}

/**
 * Why a shell command must not run, or undefined when it may.
 * @param command - raw `command` argument of bash/pwsh.
 * @param workspace - session workspace (absolute); relative targets resolve against it.
 */
export const writeGuardReason = (command, workspace, options = {}) => {
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  if (typeof workspace !== 'string' || !workspace.startsWith('/')) return undefined
  const root = normalize(workspace)
  const allowNewFileWrites = options.allowNewFileWrites !== false
  // Middle state (2026-11-01, after the strict guard measured 18.7% of bash
  // calls): in-place editors and shell redirects are allowed again, because the
  // observed damage came from scripted whole-file rewrites, and a block costs a
  // round. `guardShellWrites: true` restores the strict rules.
  const guardShellWrites = options.guardShellWrites === true
  const temp = TEMP_MENTION.test(command)
  const { segments, redirects } = scan(command)

  // Effective cwd per segment: `cd X && …` keeps writing under X, and a `cd`
  // into /tmp makes the following relative targets temp files, not workspace
  // writes (adversarial review: `cd /tmp/x && cat > probe.js` was blocked).
  const bases = []
  let base = root
  for (const segment of segments) {
    if (segment.words[0] === 'cd') {
      const next = resolveAgainst(segment.words[1] ?? '', base)
      if (next !== undefined) base = next
      bases.push(base)
      continue
    }
    bases.push(base)
  }

  for (const [index, segment] of segments.entries()) {
    const words = segment.words
    const here = bases[index] ?? root
    if (words[0] === 'cd') continue

    // 1. In-place editors, including `xargs sed -i` / `find -exec sed -i`.
    const rest = guardShellWrites ? inPlaceEditor(words) : undefined
    if (rest !== undefined) {
      const operands = inPlaceOperands(rest)
      if (operands.some(operand => inWorkspace(operand, here, root))) return WORKSPACE_WRITE_REASON
      if (operands.length === 0 && !temp) return WORKSPACE_WRITE_REASON
    }

    // 3. `tee` writing a source file (also behind sudo/env).
    const tee = guardShellWrites ? words.findIndex(word => baseName(word) === 'tee') : -1
    if (tee >= 0) {
      for (const word of words.slice(tee + 1)) {
        if (word.startsWith('-')) continue
        if (SOURCE_SUFFIX.test(word) && inWorkspace(word, here, root) && !(allowNewFileWrites && isNewFile(word, here))) {
          return WORKSPACE_WRITE_REASON
        }
      }
    }

    // 4. Interpreter inline code / heredoc writing files.
    const interpreter = baseName(words[0] ?? '')
    if (INTERPRETERS.has(interpreter)) {
      const inline = words.findIndex(word => word === '-c' || word === '-e')
      const code = inline >= 0 ? words.slice(inline + 1).join(' ') : undefined
      if (code !== undefined && SCRIPT_WRITE.test(code) && writesWorkspace(code, here, root, allowNewFileWrites)) {
        return WORKSPACE_WRITE_REASON
      }
      const body = segment.heredocs.join('\n')
      if (SCRIPT_WRITE.test(body) && writesWorkspace(body, here, root, allowNewFileWrites)) return WORKSPACE_WRITE_REASON
    }
  }

  // 2. Redirect targets into a source file, resolved against the cwd of the
  //    segment that owns the redirection (strict mode only).
  if (guardShellWrites) {
    for (const { target, owner } of redirects) {
      const here = bases[owner] ?? root
      if (SOURCE_SUFFIX.test(target) && inWorkspace(target, here, root) && !(allowNewFileWrites && isNewFile(target, here))) {
        return WORKSPACE_WRITE_REASON
      }
    }
  }

  return undefined
}

/**
 * Known limits (reviewed 2026-11-01, deliberately not covered):
 *  - strict mode (`guardShellWrites: true`) still misses `cp` / `mv` / `install` /
 *    `git checkout --` / `git apply` / `prettier --write`: text heuristics cannot
 *    separate "copy a build artifact" from "overwrite source".
 *  - `bash -c "…"` nested scripts are not re-scanned (the quoted word is one token).
 *  - a path held in a variable (`>"$target"`) is not resolved; the guard prefers a
 *    miss over a wrong block.
 *  - a shell script written to /tmp that later runs `sed -i` is out of scope by design.
 *  - the workspace must be a posix path; a Windows cwd (`C:\\…`) disables the write
 *    rules (the sleep rule still applies) until normalize() learns drive letters.
 */
