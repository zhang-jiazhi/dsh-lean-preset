import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SLEEP_REASON, WORKSPACE_WRITE_REASON, sleepGuardReason, writeGuardReason } from '../write-guard.mjs'

const WS = '/Users/dev/project'

// Strict mode: the original rules, new files included. Most cases below test
// that mode; the middle state (production default) has its own tests.
const STRICT = { allowNewFileWrites: false, guardShellWrites: true }
const denied = (command, workspace = WS) => writeGuardReason(command, workspace, STRICT) === WORKSPACE_WRITE_REASON
const allowed = (command, workspace = WS) => writeGuardReason(command, workspace, STRICT) === undefined

test('strict: in-place editors on workspace files are denied', () => {
  assert.ok(denied('sed -i "s/old/new/" src/lib/x.ts'))
  assert.ok(denied('sed -i.bak -e "s/a/b/" -e "s/c/d/" scripts/sync.ts'))
  assert.ok(denied('perl -pi -e "s/a/b/" src/x.mjs'))
  assert.ok(denied('sed -i "" "s/a/b/" src/x.ts'))
  assert.ok(denied('sed -i "s|a|b|" src/x.ts'))
  assert.ok(denied('sed --in-place=.bak "s/a/b/" src/x.ts'))
  // Multi-file: a workspace operand anywhere in the run is enough.
  assert.ok(denied('sed -i "s/a/b/" /tmp/a.ts src/x.ts'))
  assert.ok(denied('sed -i "s/a/b/" src/x.ts /tmp/y.ts'))
  // Bulk runs whose file list arrives through xargs/find.
  assert.ok(denied('git ls-files -z | xargs -0 sed -i "s/a/b/"'))
  assert.ok(denied('find . -name "*.ts" -exec sed -i "s/a/b/" {} +'))
  assert.ok(allowed('sed -i "s/a/b/" /tmp/x.ts'))
  assert.ok(allowed('sed -i "s/a/b/" /private/var/folders/tmp/x.ts'))
  assert.ok(allowed('sed -i "s/a/b/" /Users/dev/other/x.ts'))
  assert.ok(allowed('sed -n "1,20p" src/lib/x.ts'))
})

test('strict: source redirects into the workspace are denied, logs and temp are not', () => {
  assert.ok(denied("cat > src/x.ts <<'EOF'\nconst a = 1\nEOF"))
  assert.ok(denied('printf "%s" "$body" >> README.md'))
  assert.ok(denied('echo "x" > ./package.json'))
  assert.ok(denied('node script.js > result.json'))
  assert.ok(allowed('npm test > /tmp/out.log 2>&1'))
  assert.ok(allowed('npm test > build.log 2>&1'))
  assert.ok(allowed('curl -s url > report.csv'))
  assert.ok(allowed('echo done > /dev/null'))
  assert.ok(allowed('make 2>&1 | tee /tmp/build.log'))
  assert.ok(allowed('echo KEY=1 >> .env.local'))
})

test('quoted text that only mentions a write is not a write', () => {
  assert.ok(allowed('echo "写入 > src/x.ts "'))
  assert.ok(allowed('echo "a > b"'))
  assert.ok(allowed("awk '$3 > 10 {print}' src/x.ts"))
  assert.ok(allowed('grep -rn "sed -i" src/'))
  assert.ok(allowed('rg "cat > " docs/'))
  assert.ok(allowed('echo "use >> src/x.ts"'))
})

test('strict: tee and scripted writes into workspace sources are denied', () => {
  assert.ok(denied('echo x | tee src/x.ts'))
  assert.ok(denied('echo x | tee -a src/x.ts'))
  assert.ok(denied('echo x | sudo tee CHANGELOG.md'))
  assert.ok(denied('python3 - <<PY\nopen("src/lib/x.ts", "w").write(text)\nPY'))
  assert.ok(denied('python3 - <<PY\nopen("src/x.ts", mode="w")\nPY'))
  assert.ok(denied('node - <<JS\nrequire("fs").writeFileSync("src/x.ts", body)\nJS'))
  assert.ok(denied('python3 - <<PY\nPath("src/x.ts").write_text(body)\nPY'))
  // Inline code writes are caught too.
  assert.ok(denied('node -e "require(\'fs\').writeFileSync(\'src/x.ts\', body)"'))
  assert.ok(denied('python3 -c "open(\'src/x.ts\',\'w\').write(s)"'))
  // A /tmp mention elsewhere must not exempt a workspace write (full-audit finding).
  assert.ok(denied('rm -f /tmp/x; python3 - <<PY\nopen("src/x.ts", "w").write(s)\nPY'))
  assert.ok(denied('cd /tmp && python3 - <<PY\nopen("/Users/dev/project/src/x.ts","w")\nPY'))
  // A variable target is still judged from the assignment nearby.
  assert.ok(denied('python3 - <<PY\np = "src/x.ts"\nopen(p, "w").write(s)\nPY'))
  // Reading a workspace file and writing the result to /tmp is not a workspace write.
  assert.ok(allowed('python3 - <<PY\ns = open("src/x.ts").read()\nopen("/tmp/out.json", "w").write(s)\nPY'))
  // Run from /tmp, the same relative path lands in /tmp.
  assert.ok(allowed('cd /tmp && python3 - <<PY\nopen("src/x.ts","w")\nPY'))
})

test('read-only scripts and temp writes stay allowed', () => {
  assert.ok(allowed('python3 - <<PY\nprint(open("src/x.ts").read())\nPY'))
  assert.ok(allowed('python3 - <<PY\nopen("/tmp/x.ts", "w").write(text)\nPY'))
  assert.ok(allowed('node -e "require(\'fs\').writeFileSync(\'/tmp/x.ts\', body)"'))
  assert.ok(allowed('node -e "console.log(1)"'))
  assert.ok(allowed('psql -c "COPY (SELECT 1) TO \'x.csv\'"'))
  assert.ok(allowed('ls -la'))
  assert.ok(allowed('git status --short'))
})

test('a heredoc that merely contains write commands is not a write', () => {
  // The adversarial review's own regression: writing a script/fixture that
  // quotes `sed -i …` was blocked by the first text-scan version.
  assert.ok(allowed("cat > /tmp/fixture.mjs <<'EOF'\nconst cases = [['sed -i \"s/a/b/\" src/x.ts']]\nEOF"))
  assert.ok(allowed("cat > /tmp/run.sh <<'EOF'\nsed -i \"s/a/b/\" \"$f\"\nEOF"))
  // `<<-` heredocs close on a tab-indented delimiter.
  assert.ok(allowed("cat > /tmp/run.sh <<-'EOF'\n\tsed -i \"s/a/b/\" \"$f\"\n\tEOF"))
  assert.equal(sleepGuardReason("cat > /tmp/x.sh <<-'EOF'\n\tsleep 30\n\tEOF"), undefined)
})

test('long sleeps are denied, short pacing sleeps are not', () => {
  for (const command of ['sleep 30', 'sleep 60; echo x', 'cd /tmp && sleep 30', 'for i in 1 2; do sleep 45; done', 'nohup sleep 60 &', 'sleep 1m']) {
    assert.equal(sleepGuardReason(command), SLEEP_REASON, command)
  }
  for (const command of ['sleep 1', 'sleep 2', 'sleep 5', 'sleep 9', 'sleep 10', 'sleep 29', 'sleep 0.5', 'echo sleeping', 'ls -la', 'sleeping_bag=1', 'python3 - <<PY\nimport time\ntime.sleep(1)\nPY', 'echo "sleep 5"', 'echo "a && sleep 1"']) {
    assert.equal(sleepGuardReason(command), undefined, command)
  }
  // A script that *contains* sleep is not itself sleeping.
  assert.equal(sleepGuardReason("cat > /tmp/x.sh <<'EOF'\nsleep 30\necho done\nEOF"), undefined)
  // The denial must name a reachable collection path (job tools are gateway-only).
  assert.match(SLEEP_REASON, /`tool_gateway`/)
  assert.match(SLEEP_REASON, /`job_output`/)
})

test('relative writes after cd follow the effective cwd', () => {
  assert.ok(allowed('cd /tmp/probe && cat > run.js <<EOF\nconsole.log(1)\nEOF'))
  assert.ok(allowed('cd /tmp/probe && sed -i "s/a/b/" x.ts'))
  assert.ok(denied('cd /Users/dev/project/app && cat > src/x.ts <<EOF\nx\nEOF'))
})

test('tilde paths expand to the home directory', () => {
  const home = homedir()
  const workspace = `${home}/项目/demo`
  assert.ok(denied('cat > ~/项目/demo/src/x.ts <<EOF\nx\nEOF', workspace))
  assert.ok(allowed('cat > ~/elsewhere/x.ts <<EOF\nx\nEOF', workspace))
  assert.ok(denied('sed -i "s/a/b/" ~/项目/demo/src/x.ts', workspace))
})

test('middle state (default): shell writes pass, scripted writes to existing files do not', () => {
  // A fixture outside /tmp: the guard deliberately treats temp paths as free.
  const workspace = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.guard-'))
  try {
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'x.ts'), 'export const a = 1\n')
    const check = (command, options) => writeGuardReason(command, workspace, options) === undefined
    // Allowed by default: in-place editors, redirects, tee, new files.
    assert.ok(check('sed -i "s/a/b/" src/x.ts'))
    assert.ok(check("cat > src/x.ts <<'EOF'\nexport const a = 2\nEOF"))
    assert.ok(check('echo x | tee src/x.ts'))
    assert.ok(check("cat > src/new.ts <<'EOF'\nexport const b = 2\nEOF"))
    assert.ok(check("python3 - <<'PY'\nopen('src/new.ts', 'w').write('x')\nPY"))
    // Still blocked: scripted writes to an existing file.
    assert.ok(!check("python3 - <<'PY'\nopen('src/x.ts', 'w').write('x')\nPY"))
    assert.ok(!check('node -e "require(\'fs\').writeFileSync(\'src/x.ts\', body)"'))
    // Strict mode restores the shell rules and new-file blocking.
    assert.ok(!check("cat > src/x.ts <<'EOF'\nx\nEOF", { guardShellWrites: true }))
    assert.ok(!check("cat > src/new.ts <<'EOF'\nx\nEOF", { allowNewFileWrites: false, guardShellWrites: true }))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('paths outside the workspace and unknown workspaces are not judged', () => {
  assert.ok(allowed('sed -i "s/a/b/" /Users/dev/other/x.ts'))
  assert.ok(allowed('cat > src/x.ts <<EOF\nx\nEOF', ''))
  assert.equal(writeGuardReason(undefined, WS), undefined)
  assert.equal(writeGuardReason('', WS), undefined)
})
