# crap-agent-tools plan

Drafted 2026-11-13. `crap-agent-tools` is a working name. The implementing
thread should correct this plan wherever real tool behaviour contradicts it.

## Goal

A coding agent can ask "which functions I just changed are riskiest, and what
tests are missing?" and get a short, structured, deterministic answer built on
`ts-crap`.

## Known constraints

- The tool is read-only: no code edits, no writes outside a temp directory, no
  network calls of its own.
- Output goes into a model's context, so it is bounded and stable in order.
- On this Android/Termux host the `typescript-crap` npm launcher does not run
  under Termux's node and skips the Linux platform package. The static
  linux-arm64 release binary (v2.4.0) does run. Locating the scanner must not
  assume the npm launcher works.
- Naming a file inside a directory `ts-crap` excludes (`dist/`,
  `node_modules/`) is a hard error, so diff selection must apply the same
  exclusions before invoking it.

## Milestones

### M1 — Core — done

- Bounded process runner (timeout, output cap, no shell).
- Diff selection: changed files against a merge base, filtered to what
  `ts-crap` accepts.
- Run `ts-crap` with JSON output, validate the report version and shape.
- Return a ranked list of changed functions: path, line, complexity,
  coverage, CRAP score, gate result, and a plain statement of missing
  evidence.

**Acceptance:** tests cover no changed functions, scanner missing, scanner
timeout, malformed JSON, unexpected report version, excluded paths in the
diff, and output over the bound. Results are identical across repeated runs.

**Status (met):** `core/` (`analyze.mjs`, `exec.mjs`, `git.mjs`, `scanner.mjs`,
`ts-crap.mjs`); 21 tests in `test/core.test.mjs`, two of them against the
real ts-crap 2.4.0 binary when `TS_CRAP_TEST_BIN` is set. Beyond the plan:
untracked and renamed files count as changed; a changed line belongs to the
innermost function containing it; coverage is optional (without it every
score is the worst case and the answer says so); stale coverage, oversized
scanner output and rows naming unselected files are refused; names and paths
are stripped of control and bidirectional characters; minimum scanner version
is 2.4.0 (`--on-syntax-error report`).

### M2 — Pi extension

- One tool with a small parameter set (base ref, limit, threshold).
- Structured result plus a short text summary.
- Follows the structure and safety notes of `pi-android-screenshots`.

**Acceptance:** loads in a real Pi session on this host with `pi -e`, and
returns a correct answer for a throwaway repository. Nothing is installed
permanently into the live Pi configuration.

### M3 — MCP server (conditional)

- Same core behind an MCP stdio server.
- Build only if it stays a thin adapter. Otherwise record why it was skipped.

**Acceptance:** one tool, same result shape as the Pi extension, covered by a
protocol-level test.

### M4 — Scanner discovery and README

- Documented lookup order for the scanner: explicit path, project
  `node_modules`, PATH.
  *Correction:* the project binary is opt-in (`allowProjectScanner`), because
  it comes from the repository under analysis; and it is the platform
  package's native binary, not the npm launcher, which refuses this host. A
  broken candidate is an error, never a silent fall-through to the next one.
  (Implemented in M1, `core/scanner.mjs`.)
- README: what it does, what it does not do, privacy, limits, removal.
- CI workflow file for the tests (not pushed anywhere yet).

**Acceptance:** a stranger can install and remove it from the README alone.

### M5 — Extension points (design only)

- A scanner interface that `dotnet-crap` could implement.
- A place for mutation evidence once `ts-crap` reports it.

**Acceptance:** a short design section; no second scanner is built.

## Out of scope

- Editing code or writing tests on the agent's behalf.
- Creating a GitHub repository or publishing to npm.
- Depending on unreleased `ts-crap` features.

## Decisions for the owner

1. Final name.
2. Own repository, or a package inside `typescript-crap`.
3. Whether to keep the MCP surface.
