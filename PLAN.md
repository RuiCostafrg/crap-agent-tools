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

### M2 — Pi extension — done

- One tool with a small parameter set (base ref, limit, threshold).
- Structured result plus a short text summary.
- Follows the structure and safety notes of `pi-android-screenshots`.

**Acceptance:** loads in a real Pi session on this host with `pi -e`, and
returns a correct answer for a throwaway repository. Nothing is installed
permanently into the live Pi configuration.

**Status (met):** `pi-extension/index.ts` registers `changed_risk` (parameters
base, limit, threshold, coverage, scope; read-only annotations; prompt snippet
and guidelines). Name, description, schemas and argument checks live in
`core/surface.mjs` so M3 can reuse them. The project root is the session's
`cwd`; the scanner comes from `CRAP_AGENT_TS_CRAP` or PATH, never from tool
arguments, which are a closed set. Verified on Pi 1.5.2: `test/pi.test.mjs`
runs a real `pi --mode json -e …` session (no discovered extensions, no
context files, no session file, offline) with a scripted model built on Pi's
own faux provider, and checks the ranked answer, an unknown argument, an
invalid limit and a missing scanner. A run with the configured real model
loaded the tool and its guidelines into the system prompt but stopped at the
provider (subscription usage limit), so model-driven tool choice is unverified.
*Correction:* the test must remove `NODE_TEST_CONTEXT` from Pi's environment,
or Pi, being a Node program, reports to the test runner and the results vanish.

### M3 — MCP server (conditional) — done

- Same core behind an MCP stdio server.
- Build only if it stays a thin adapter. Otherwise record why it was skipped.

**Acceptance:** one tool, same result shape as the Pi extension, covered by a
protocol-level test.

**Status (met):** `mcp-server/server.mjs`, about 110 lines with no dependencies:
newline-delimited JSON-RPC over stdio, protocol versions 2025-11-25 and
2025-06-18 (the first with structured tool output), `initialize`, `ping`,
`tools/list`, `tools/call`, `notifications/cancelled` (aborts the scan and
sends no reply), at most 4 calls in flight, 1 MiB message cap. It reuses
`core/surface.mjs` unchanged, so the tool, schemas and text are identical to
the Pi extension. Project root: `CRAP_AGENT_ROOT` or the directory the client
starts it in. `test/mcp.test.mjs` drives the real process over pipes;
`test/pi.test.mjs` also reaches it through Pi's built-in MCP client
(registered for one session with `pi.registerMcpServer`) and checks the
answer equals the extension's. *Finding:* Pi gives MCP servers `codemode`
exposure by default; a server meant to be called directly needs
`"exposure": "direct"`.

### M4 — Scanner discovery and README — done

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

**Status (met):** `README.md` covers what it does and does not do, requirements
and scanner lookup, arguments and operator variables, Pi (one-off `pi -e`,
`pi install`, `pi remove`), MCP client configuration and removal, limits,
privacy and tests. The Pi install and removal steps were run against an
isolated `PI_CODING_AGENT_DIR`, which also confirmed that the installed package form
loads the tool; the live configuration was not touched.
`.github/workflows/test.yml` runs the tests on Node 22 and 24 against the
pinned npm platform binary (not pushed; never run). *Correction:* Node 22 is the
minimum, because `node --test` with a glob needs it; `engines` says so.

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
