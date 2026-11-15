<img src="assets/icon.svg" width="64" height="64" alt="">

# crap-agent-tools

A read-only tool for coding agents. It answers one question about the agent's
own diff: **which functions I just changed are riskiest, and what tests are
missing?** It runs [`ts-crap`](https://github.com/RuiCostafrg/typescript-crap)
on the TypeScript files and [`dotnet-crap`](https://github.com/RuiCostafrg/dotnet-crap)
on the C# files changed since a base commit. It returns one short ranked list
across both languages: path, line, complexity, coverage, CRAP score, whether
each function fails the gate, and a plain statement of the missing test evidence.

There are two ways to reach the same core:

- a **Pi extension** that registers the tool `changed_risk`;
- an **MCP stdio server** that serves the same tool to any MCP client.

Status: early. It is not published to npm; use it from a clone. MIT licensed.

## What it does

- Selects the files changed since `merge-base(base, HEAD)`: committed, staged,
  unstaged and untracked work. The default base is `HEAD`, so only
  uncommitted changes count.
- Groups the changed files by language and drops the ones each scanner
  would refuse or skip:
  - TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`): `.d.ts` files and files under
    `node_modules`, `dist`, `build`, `coverage`, `target`, `.git` or
    `excluded_directories` from `ts-crap.json`. Naming one of those is a hard
    error in `ts-crap`.
  - C# (`.cs`): files under `bin`, `obj` or `.git`, and generated
    `*.g.cs`, `*.generated.cs` and `*.designer.cs` files.
- Runs each scanner with JSON output, but only for a language with changed
  files. A scanner you don't need is never looked up. It validates each
  report's shape (and ts-crap's report version), and refuses anything it
  cannot trust.
- A C# file that does not parse stops a dotnet-crap scan. The tool rescans
  without that file, up to 10 times, and lists it under `syntaxErrors`.
- Marks a function as changed when it owns a changed line, meaning it is the
  innermost function containing that line. A deletion inside a function also
  counts.
- Ranks all languages together: gate failures first, then by CRAP score, then complexity, then path,
  line and name. The same input always gives the same answer.
- Says what evidence is missing for each function:

  | `evidence` | Meaning |
  |---|---|
  | `not_measured` | No coverage file was given. The score assumes 0% coverage (the worst case). |
  | `no_file_coverage` | The coverage data has no entry for the file, so no test loaded it. |
  | `no_function_coverage` | C#: the coverage data has no points inside the function, so it counts as 0%. |
  | `uncovered` | No test executes the function. |
  | `partial` | Lists the line-coverage percentage and the lines never executed, and says which of them changed in this diff. |
  | `covered` | Every line runs under test. Branches are not measured. |

  For a failing function, the answer also gives the coverage it needs to pass.
  If its complexity alone exceeds the threshold, the answer says more tests
  cannot help and the function has to be split.

Example text result. Structured data is returned alongside it.

```text
ts-crap 2.4.0 (TypeScript, threshold 10, coverage not supplied); dotnet-crap 0.1.0 (C#, threshold 10, coverage not supplied); base HEAD (merge base 7454ecae2732).
2 changed function(s) in 3 changed file(s); failing the gate: 2. Gate over the whole changed files: FAIL.
1. FAIL src/price.ts:1 price - CRAP 30, complexity 5, coverage 0%. No coverage data was supplied, so coverage counts as 0%; this score is the worst case. It needs at least 42% line coverage to pass the threshold 10.
2. FAIL cs/Calc.cs:5 Price - CRAP 20, complexity 4, coverage 0%. No coverage data was supplied, so coverage counts as 0%; this score is the worst case. It needs at least 28% line coverage to pass the threshold 10.
Does not parse: cs/Bad.cs
Note: Coverage was not supplied for TypeScript: every TypeScript score assumes 0% coverage. Pass coverage to see which lines tests miss.
Note: Coverage was not supplied for C#: every C# score assumes 0% coverage. Pass coverage to see which lines tests miss.
Note: 2 changed C# file(s) are build, dependency or generated paths dotnet-crap excludes and were not scored.
Note: 1 changed file(s) do not parse; their functions are missing from this answer.
```

The structured result (schema `crap-agent-tools/changed-risk/v2`) has
`scanners[]`: one entry per language that was scanned, with its name,
version, threshold, changed file count, whether coverage was supplied, and
its gate results. It also has `totals`, the ranked `functions[]` (each with
`language`), `omitted`, `syntaxErrors[]` and `notes[]`.

## What it does not do

- It does not edit code, write tests, run tests or collect coverage. It only
  reads a coverage file the project has already produced.
- It does not write files. Its only child processes are `git`, `ts-crap` and
  `dotnet-crap`, and none of them writes into the repository.
- It makes no network calls of its own and sends nothing anywhere. The
  answer goes into the agent's context like any other tool result, and your
  model provider receives it there.
- It does not measure branch coverage. Both scanners' coverage is line based.
- It does not replace the CI gate. CI scores whole changed files, so the
  answer reports unchanged functions in those files that fail as well.
- It covers TypeScript and C# only. It does not cover F#, Visual Basic or
  JavaScript.

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
- For C#: `dotnet-crap` 0.1.0 or newer, found through `CRAP_AGENT_DOTNET_CRAP`
  (an absolute path), then `dotnet-crap` on `PATH`. There is no project-local
  lookup. Get it from the
  [releases](https://github.com/RuiCostafrg/dotnet-crap/releases). The static
  `aarch64-unknown-linux-musl` build runs on Android/Termux. Scanning needs no
  .NET SDK.

Each scanner is needed only when files of its language changed. If both
languages changed and one scanner is missing, the error says so and suggests
`language` to analyse just the other.

## Tool arguments

All arguments are optional, and unknown arguments are rejected.

| Argument | Default | Meaning |
|---|---|---|
| `base` | `HEAD` | Git ref or commit to compare against through the merge base, for example `origin/main`. |
| `limit` | `10` | Maximum number of functions to return (1 to 50). |
| `threshold` | ts-crap: project config, else 10. dotnet-crap: 10 | CRAP threshold, applied to every scanner. |
| `coverage` | none | Native coverage JSON relative to the project root. A path when one language changed; `{"typescript": "...", "csharp": "..."}` when both did. |
| `language` | `auto` | `auto`: every language with changed files. `typescript` or `csharp`: only that one. |
| `scope` | `changed` | `changed`: only the functions that own a changed line. `files`: every function in the changed files. |

Coverage files come from the scanners' own collectors. For TypeScript, use
`npx typescript-crap coverage --framework vitest --output coverage/ts-crap.json`.
For C#, use `dotnet-crap collect --root "$PWD" --output "$PWD/coverage/cs.json" -- dotnet test …`
(see dotnet-crap's [Coverlet guide](https://github.com/RuiCostafrg/dotnet-crap/blob/main/docs/COVERLET.md)).
Both bind coverage to the exact source bytes, so editing a file after collecting
coverage gives `coverage_stale`.

Operator settings, read from the environment only:

| Variable | Meaning |
|---|---|
| `CRAP_AGENT_TS_CRAP` | Absolute path to `ts-crap`. |
| `CRAP_AGENT_DOTNET_CRAP` | Absolute path to `dotnet-crap`. |
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
CRAP_AGENT_TS_CRAP=/path/to/ts-crap CRAP_AGENT_DOTNET_CRAP=/path/to/dotnet-crap \
  pi -e /path/to/crap-agent-tools/pi-extension/index.ts
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
{"language": "csharp", "coverage": "coverage/cs.json"}
{"coverage": {"typescript": "coverage/ts-crap.json", "csharp": "coverage/cs.json"}}
```

From codemode, `await tools.changed_risk({base: "origin/main"})` returns the
structured result.

**Removal:** run `pi remove /path/to/crap-agent-tools`, then `/reload` or
restart Pi. Check with `pi list`. If you only used `pi -e`, there is nothing
to remove.

The tool is registered with read-only annotations
(`readOnlyHint: true`, `openWorldHint: false`). Its prompt guidelines tell the
model to use it after changing TypeScript or C# functions. Function names and paths
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
      "env": { "CRAP_AGENT_TS_CRAP": "/path/to/ts-crap", "CRAP_AGENT_DOTNET_CRAP": "/path/to/dotnet-crap" }
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
- At most 1000 changed source files. Beyond that the tool asks for a
  closer base.
- A scanner report can be at most 32 MiB, and a coverage file at most 64 MiB.
  A scan times out after 120 s by default. The limit applies to each scanner
  run, including each dotnet-crap rescan.
- The MCP server runs at most 4 calls at once and accepts messages up to
  1 MiB.

## Tests

```bash
npm test
```

Core tests use throwaway git repositories and scripted stand-ins for both
scanners. More groups run only when their requirements are set:

```bash
# Against the real scanners:
TS_CRAP_TEST_BIN=/path/to/ts-crap DOTNET_CRAP_TEST_BIN=/path/to/dotnet-crap npm test
# Also in real Pi sessions (scripted model, offline, nothing installed):
PI=$(command -v pi) TS_CRAP_TEST_BIN=/path/to/ts-crap DOTNET_CRAP_TEST_BIN=/path/to/dotnet-crap npm test
```

The Pi tests run `pi --mode json` with no discovered extensions, no context
files and no session file, plus a test-only extension that drives the session
with Pi's own faux provider. They make no network calls and need no
credentials. One test reaches the MCP server through Pi's built-in MCP client,
registered for that session only, and scores a mixed TypeScript and C# change.

## Extension points

### Scanner adapters

Everything specific to one scanner lives in one adapter object:
`core/ts-crap.mjs` and `core/dotnet-crap.mjs`. `ADAPTERS` in
`core/analyze.mjs` lists them in answer order. Another scanner with the same
report roles needs only another object of this shape:

| Member | Role |
|---|---|
| `id`, `name`, `command`, `language`, `installHint` | The `language` argument value, names used in messages, and the command name looked up on PATH |
| `versionArguments`, `parseVersion(text)`, `minimumVersion` | Version check before any scan |
| `projectBinaries(root)` | Optional project-local executables, used only when allowed |
| `isSource(file)` | Whether a changed file belongs to this language |
| `excludedDirectories(root)`, `selects(file, excluded)` | Which of those files the scanner accepts, so a file it would refuse or skip is never named |
| `scanArguments({ root, files, coverage, threshold })` | The exact argument vector. No shell is involved |
| `hasReport(exitCode)` | Which exit codes still carry a report (a gate failure is not a tool failure) |
| `parseReport(text)` | Validates the report and returns `{ threshold, failed, completenessFailed, functions[], syntaxErrors[] }`, each function with `path, line, endLine, column, name, complexity, coverage, coverageMeasured, crap, failed` |
| `syntaxErrorPath(stderr)` | For scanners that stop on invalid source: the file to rescan without, or `null` |
| `readCoverage(file)` | Per-line hit counts for the "lines never executed" evidence, or `null` |

### Mutation evidence (design only)

Once ts-crap or dotnet-crap reports mutation results per function,
`parseReport` would add an optional `mutation` field to each row, for
example `{ killed, survived, timedOut }`. `describeEvidence` in
`core/analyze.mjs` would then add kinds such as `surviving_mutants`. That
kind means lines run under test but the assertions miss changes, and it would
list the surviving mutants on changed lines, bounded like `uncoveredLines`.
The new fields are additive, so the result schema stays `v2`, and ranking
stays CRAP first. Until a released scanner reports mutation data, nothing
reads it.

## Layout

```text
core/          analysis core (no dependencies)
  analyze.mjs    diff -> scan -> rank -> bounded answer; text rendering
  ts-crap.mjs    TypeScript scanner adapter: selection, invocation, report validation
  dotnet-crap.mjs  C# scanner adapter, same shape
  adapter-util.mjs helpers both adapters share (bounded reads, coverage-v1)
  scanner.mjs    scanner lookup and version check
  git.mjs        changed files and line ranges since a merge base
  exec.mjs       bounded child processes (no shell, timeout, output cap)
  surface.mjs    the one tool: name, schemas, argument checks, config
pi-extension/  Pi extension (index.ts)
mcp-server/    MCP stdio server (server.mjs)
test/          node:test suites; test/pi/ holds the Pi session harness
```
