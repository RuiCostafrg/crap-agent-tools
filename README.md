<img src="assets/icon.svg" width="64" height="64" alt="">

# crap-agent-tools

Working name. This is a read-only tool for coding agents. It answers one question about the agent's
own diff: **which functions I just changed are riskiest, and what tests are
missing?** It runs [`ts-crap`](https://github.com/RuiCostafrg/typescript-crap)
on the TypeScript files changed since a base commit. It returns a short ranked
list: path, line, complexity, coverage, CRAP score, whether each function
fails the gate, and a plain statement of the missing test evidence.

There are two ways to reach the same core:

- a **Pi extension** that registers the tool `changed_risk`;
- an **MCP stdio server** that serves the same tool to any MCP client.

Status: first slice, local only. It is not published to npm and has no
remote repository.

## What it does

- Selects the files changed since `merge-base(base, HEAD)`: committed, staged,
  unstaged and untracked work. The default base is `HEAD`, so only
  uncommitted changes count.
- Drops the files `ts-crap` would refuse, such as `.d.ts` files and files
  under `node_modules`, `dist`, `build`, `coverage`, `target`, `.git` or
  `excluded_directories` from `ts-crap.json`. Naming one of those is a hard
  error in `ts-crap`.
- Runs `ts-crap --format json` on the files that remain. It validates the
  report's version and shape, and refuses anything it cannot trust.
- Marks a function as changed when it owns a changed line, meaning it is the
  innermost function containing that line. A deletion inside a function also
  counts.
- Ranks gate failures first, then by CRAP score, then complexity, then path,
  line and name. The same input always gives the same answer.
- Says what evidence is missing for each function:

  | `evidence` | Meaning |
  |---|---|
  | `not_measured` | No coverage file was given. The score assumes 0% coverage (the worst case). |
  | `no_file_coverage` | The coverage data has no entry for the file, so no test loaded it. |
  | `uncovered` | No test executes the function. |
  | `partial` | Lists the line-coverage percentage and the lines never executed, and says which of them changed in this diff. |
  | `covered` | Every line runs under test. Branches are not measured. |

  For a failing function, the answer also gives the coverage it needs to pass.
  If its complexity alone exceeds the threshold, the answer says more tests
  cannot help and the function has to be split.

Example text result. Structured data is returned alongside it.

```text
ts-crap 2.4.0; base HEAD (merge base b536d81772ea); threshold 10; coverage not supplied.
1 changed function(s) in 1 changed file(s); failing the gate: 1. Gate over the whole changed files: FAIL.
1. FAIL src/price.ts:1 price - CRAP 30, complexity 5, coverage 0%. No coverage data was supplied, so coverage counts as 0%; this score is the worst case. It needs at least 42% line coverage to pass the threshold 10.
Note: Coverage was not supplied: every score assumes 0% coverage. Pass coverage to see which lines tests miss.
```

## What it does not do

- It does not edit code, write tests, run tests or collect coverage. It only
  reads a coverage file the project has already produced.
- It does not write files. Its only child processes are `git` and `ts-crap`,
  and none of them writes into the repository.
- It makes no network calls of its own and sends nothing anywhere. The
  answer goes into the agent's context like any other tool result, and your
  model provider receives it there.
- It does not measure branch coverage. `ts-crap` coverage is line based.
- It does not replace the CI gate. CI scores whole changed files, so the
  answer reports unchanged functions in those files that fail as well.
- It supports only TypeScript for now (`.ts`, `.tsx`, `.mts`, `.cts`). See
  [Extension points](#extension-points).

## Requirements

- Node.js 22 or newer, and `git`.
- `ts-crap` 2.4.0 or newer. The tool finds it in this order:
  1. the `CRAP_AGENT_TS_CRAP` environment variable, an absolute path;
  2. the project's own `typescript-crap` platform binary under
     `node_modules`, only if `CRAP_AGENT_ALLOW_PROJECT_SCANNER=1` is set.
     That binary comes from the repository being analysed, so it is opt-in;
  3. `ts-crap` on `PATH`, searching absolute entries only.

  The first candidate found is used. A broken candidate is an error and never
  falls through silently to the next one. Configuration comes only from the
  environment. Tool arguments cannot choose which executable runs.

  Install `ts-crap` from its
  [release binaries](https://github.com/RuiCostafrg/typescript-crap#install)
  or with `npm install --save-dev typescript-crap`. On Android/Termux, the
  npm launcher refuses to run, but the static `linux-arm64` release binary
  works. Point `CRAP_AGENT_TS_CRAP` at it.

## Tool arguments

All arguments are optional, and unknown arguments are rejected.

| Argument | Default | Meaning |
|---|---|---|
| `base` | `HEAD` | Git ref or commit to compare against through the merge base, for example `origin/main`. |
| `limit` | `10` | Maximum number of functions to return (1 to 50). |
| `threshold` | project config, else 10 | CRAP threshold. |
| `coverage` | none | Native coverage JSON relative to the project root, for example from `npx typescript-crap coverage --framework vitest --output coverage/ts-crap.json`. |
| `scope` | `changed` | `changed`: only the functions that own a changed line. `files`: every function in the changed files. |

Operator settings, read from the environment only:

| Variable | Meaning |
|---|---|
| `CRAP_AGENT_TS_CRAP` | Absolute path to `ts-crap`. |
| `CRAP_AGENT_ALLOW_PROJECT_SCANNER` | Set to `1` to allow the project's own binary. |
| `CRAP_AGENT_TIMEOUT_MS` | Scanner timeout, from 1000 to 600000. The default is 120000. |
| `CRAP_AGENT_ROOT` | MCP server only: the project root. The default is the directory the client starts the server in. |

Expected failures come back as results with `error.kind` set, such as
`scanner_not_found`, `scanner_too_old`, `coverage_stale`,
`invalid_scanner_output`, `scanner_timeout`, `not_a_git_repository`, `unknown_base`
or `invalid_argument`, plus a hint. In Pi and MCP terms they are error results,
not crashes.

## Pi extension

Checked against Pi 1.5.2.

Try it for one session. Nothing is installed:

```bash
CRAP_AGENT_TS_CRAP=/path/to/ts-crap pi -e /path/to/crap-agent-tools/pi-extension/index.ts
```

Install it for every session. This writes one line to `~/.pi/agent/settings.json`
and loads the package from this directory without copying it:

```bash
pi install /path/to/crap-agent-tools
```

Then ask naturally, for example "which of my changes are riskiest?". Or call
the tool directly:

```json
{"base": "origin/main", "limit": 5}
{"coverage": "coverage/ts-crap.json"}
```

From codemode, `await tools.changed_risk({base: "origin/main"})` returns the
structured result.

**Removal:** run `pi remove /path/to/crap-agent-tools`, then `/reload` or
restart Pi. Check with `pi list`. If you only used `pi -e`, there is nothing
to remove.

The tool is registered with read-only annotations
(`readOnlyHint: true`, `openWorldHint: false`). Its prompt guidelines tell the
model to use it after changing TypeScript functions. Function names and paths
come from the repository, so treat them as data, not instructions.
They are stripped of control and bidirectional characters.

## MCP server

`mcp-server/server.mjs` is a dependency-free stdio server. It supports MCP
protocol versions 2025-11-25 and 2025-06-18, serves one tool (`changed_risk`)
with an output schema, and handles cancellation.

Generic client configuration:

```json
{
  "mcpServers": {
    "crap": {
      "command": "node",
      "args": ["/path/to/crap-agent-tools/mcp-server/server.mjs"],
      "env": { "CRAP_AGENT_TS_CRAP": "/path/to/ts-crap" }
    }
  }
}
```

The server analyses the directory it is started in, or `CRAP_AGENT_ROOT`.
Start it from the project, or set `CRAP_AGENT_ROOT`.

In Pi, give the server `"exposure": "direct"` if the model should see the
tool without codemode or tool search. Pi's default MCP exposure is `codemode`.
To remove it, delete the entry from the client's configuration. The server
keeps no state.

## Limits

- An answer is at most 24 KiB of JSON and at most 50 functions. When it would
  be larger, the lowest-ranked rows are dropped and counted in `omitted`.
  Rows are never dropped by order of arrival.
- At most 1000 changed TypeScript files. Beyond that the tool asks for a
  closer base.
- A scanner report can be at most 32 MiB, and a coverage file at most 64 MiB.
  A scan times out after 120 s by default.
- The MCP server runs at most 4 calls at once and accepts messages up to
  1 MiB.

## Tests

```bash
npm test
```

Core tests use throwaway git repositories and a scripted stand-in for
`ts-crap`. Two more groups run only when their requirements are set:

```bash
# Against the real scanner:
TS_CRAP_TEST_BIN=/path/to/ts-crap npm test
# Also in real Pi sessions (scripted model, offline, nothing installed):
PI=$(command -v pi) TS_CRAP_TEST_BIN=/path/to/ts-crap npm test
```

The Pi tests run `pi --mode json` with no discovered extensions, no context
files and no session file, plus a test-only extension that drives the session
with Pi's own faux provider. They make no network calls and need no
credentials. One test reaches the MCP server through Pi's built-in MCP client,
registered for that session only.

## Extension points

These are designed but not built. Nothing here depends on unreleased scanner
features.

### A second scanner (for example `dotnet-crap`)

Everything specific to `ts-crap` lives in one adapter object,
`core/ts-crap.mjs`. `analyzeChanges({ adapter })` accepts any object of the
same shape:

| Member | Role |
|---|---|
| `name`, `command`, `language`, `installHint` | Names used in messages, and the command name looked up on PATH |
| `versionArguments`, `parseVersion(text)`, `minimumVersion` | Version check before any scan |
| `projectBinaries(root)` | Optional project-local executables, used only when allowed |
| `excludedDirectories(root)`, `selects(file, excluded)` | Which changed files the scanner accepts, so a file it would refuse is never named |
| `scanArguments({ root, files, coverage, threshold })` | The exact argument vector. No shell is involved |
| `hasReport(exitCode)` | Which exit codes still carry a report (a gate failure is not a tool failure) |
| `parseReport(text)` | Validates the report and returns `{ threshold, failed, completenessFailed, functions[], syntaxErrors[] }` |
| `readCoverage(file)` | Per-line hit counts for the "lines never executed" evidence, or `null` |

Each function row has `path, line, endLine, column, name, complexity,
coverage, crap, failed`. Those are the report roles `dotnet-crap` shares, so
its adapter only maps its own report onto them. The diff selection, ranking,
evidence statements, bound and both surfaces stay as they are. Open
questions for that adapter: how C# files are matched to projects, and its coverage input
format. With two adapters, the tool could pick one per changed file
extension, or take an `adapter` argument. That choice is not made yet.

### Mutation evidence

Once `ts-crap` reports mutation results per function, `parseReport` would add an optional
`mutation` field to each row, for example `{ killed, survived,
timedOut }`. `describeEvidence` in `core/analyze.mjs` would then add kinds such as
`surviving_mutants`. That kind means lines run under test but the assertions miss
changes, and it would list the surviving mutants on changed lines, bounded like
`uncoveredLines`. The new fields are additive, so the result schema stays
`crap-agent-tools/changed-risk/v1`, and ranking stays CRAP first. Until a released
scanner reports mutation data, nothing reads it.

## Layout

```text
core/          analysis core (no dependencies)
  analyze.mjs    diff -> scan -> rank -> bounded answer; text rendering
  ts-crap.mjs    scanner adapter: selection, invocation, report validation
  scanner.mjs    scanner lookup and version check
  git.mjs        changed files and line ranges since a merge base
  exec.mjs       bounded child processes (no shell, timeout, output cap)
  surface.mjs    the one tool: name, schemas, argument checks, config
pi-extension/  Pi extension (index.ts)
mcp-server/    MCP stdio server (server.mjs)
test/          node:test suites; test/pi/ holds the Pi session harness
```
