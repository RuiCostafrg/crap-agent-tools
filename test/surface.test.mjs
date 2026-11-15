// The shared tool surface: argument checks, operator configuration, error results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUT_SCHEMA, OUTPUT_SCHEMA, callTool, operatorConfig } from "../core/surface.mjs";
import { RESULT_SCHEMA } from "../core/analyze.mjs";

test("operator configuration comes only from the environment", () => {
  assert.deepEqual(operatorConfig({}), {});
  assert.deepEqual(operatorConfig({ CRAP_AGENT_TS_CRAP: "/opt/ts-crap", CRAP_AGENT_ALLOW_PROJECT_SCANNER: "1", CRAP_AGENT_TIMEOUT_MS: "5000" }),
    { scannerPath: "/opt/ts-crap", allowProjectScanner: true, timeoutMs: 5000 });
  assert.deepEqual(operatorConfig({ CRAP_AGENT_ALLOW_PROJECT_SCANNER: "yes" }), {});
});

test("tool arguments cannot reach operator settings or unknown options", async () => {
  let seen;
  const analyze = async options => { seen = options; return { schema: RESULT_SCHEMA, error: { kind: "x", message: "stub" } }; };
  for (const args of [{ scannerPath: "/bin/sh" }, { root: "/" }, { allowProjectScanner: true }, { env: {} }]) {
    seen = undefined;
    const result = await callTool(args, { root: "/repo", env: {}, analyze });
    assert.equal(result.isError, true);
    assert.equal(result.structured.error.kind, "invalid_argument");
    assert.equal(seen, undefined, "analysis never starts");
  }
  for (const args of [[], "x", 3]) assert.equal((await callTool(args, { root: "/repo", env: {}, analyze })).structured.error.kind, "invalid_argument");
});

test("accepted arguments, root and configuration reach the core", async () => {
  let seen;
  const answer = { schema: RESULT_SCHEMA, scanner: { name: "ts-crap", version: "2.4.0" }, base: "main", mergeBase: "abc", scope: "changed",
    threshold: 8, gate: { failed: false, completenessFailed: false },
    totals: { changedFiles: 0, functionsInChangedFiles: 0, changedFunctions: 0, failingChangedFunctions: 0, failingOtherFunctions: 0 },
    coverageSupplied: false, functions: [], omitted: 0, syntaxErrors: [], notes: [] };
  const analyze = async options => { seen = options; return answer; };
  const result = await callTool({ base: "main", limit: 3, threshold: 8, coverage: "c.json", scope: "files" },
    { root: "/repo", env: { CRAP_AGENT_TS_CRAP: "/opt/ts-crap" }, analyze });
  assert.equal(result.isError, false);
  assert.equal(result.structured, answer);
  assert.match(result.text, /^ts-crap 2\.4\.0; base main/);
  assert.deepEqual({ ...seen, env: undefined, signal: undefined },
    { root: "/repo", base: "main", limit: 3, threshold: 8, coverage: "c.json", scope: "files", scannerPath: "/opt/ts-crap", env: undefined, signal: undefined });
  assert.deepEqual((await callTool(undefined, { root: "/repo", env: {}, analyze })).structured, answer);
});

test("thrown errors become error results, never exceptions", async () => {
  const result = await callTool({}, { root: "/repo", env: {}, analyze: async () => { throw new Error("boom"); } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structured.error, { kind: "internal_error", message: "boom" });
  assert.equal(result.text, "Error (internal_error): boom");
});

test("schemas are closed on input and name every argument", () => {
  assert.equal(INPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual(Object.keys(INPUT_SCHEMA.properties), ["base", "limit", "threshold", "coverage", "scope"]);
  assert.equal(OUTPUT_SCHEMA.properties.schema.const, RESULT_SCHEMA);
});
