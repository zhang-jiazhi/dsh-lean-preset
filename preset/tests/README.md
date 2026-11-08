# LEAN regression tests

All suites resolve production services from one module tree via
`runtime-helper.mjs`. Root selection, in priority order:

1. `DSH_TEST_RUNTIME_ROOT` — absolute package root (e.g. desktop `app.asar/dsh`).
2. `DSH_PROFILE_DIR` — absolute profile directory.
3. `~/.dsh/profiles/web` — compatible default for `npm test`.

An invalid root fails visibly; there is no fallback to another runtime. Tests
resolve Session first, then all services/Cordis relative to that Session. This
avoids mismatched module-level Symbols. No separate testkit install is needed.
The compaction policy unit tests use fixed local fixtures, not mutable provider
configuration from a user's profile. Validate live profile YAML separately.

## Web runtime

The test shell needs the installed `node`, `npm` and `rg` on PATH. For a minimal
macOS GUI environment, from the preset directory:

```sh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
npm test
```

## Desktop runtime (macOS)

Plain Node cannot load Electron's ASAR module tree. Run the bundled executable
as Node; this does not start/restart the GUI or make model calls:

```sh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ELECTRON_RUN_AS_NODE=1 \
DSH_TEST_RUNTIME_ROOT='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh' \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  --expose-internals --test tests/*.test.mjs
```

Adjust the app path for a non-default installation. The shell PATH regressions
also explicitly recreate a minimal inherited PATH and verify `bash -c` CLI
lookup, caller PATH precedence, command preservation and credential isolation.
macOS-only cases are marked as such on other platforms.

## Coverage and limits

Rules/skills integration tests use the production AgentLoop, durable Session,
real Inbox and a deterministic local LLM adapter; they make no external calls.
Some focused tests use a small queue-only Inbox stub. The suite covers discovery,
bootstrap/unlock persistence, compaction recovery, batch boundaries, rules,
skills, reminder guards, shell preservation and configuration/index consistency.
Do not skip integration tests or install an older testkit as a fallback.

Verified on 2026-09-27 against web DSH 0.1.7-rc.2 (Node 26.8.1) and the installed
desktop module tree (Electron 44.0.0 / Node 24.18.1). Offline regression success
is not a remote MCP API, GUI conversation, Windows/Linux or billing test.

## Suites added for the 20261024 unlock budget

`unlock-budget.test.mjs` pins the shared `resolveToolNames()` contract used by
both discovery and assembly: a group expansion (`mcp__server`, `mcp__server__*`,
`dev_*`) must fit `UNLOCK_BUDGET` (64 tools / 60k schema chars) or it is deferred
whole, exact tool names are never budgeted away, and a deferred group does not
consume the budget of the next one. It also runs the same catalog through
`dev-tool-search.mjs` and `tool-bootstrap.mjs` to prove both sides reach the same
verdict, and keeps the deferred report inside the 3,800-char page budget.
