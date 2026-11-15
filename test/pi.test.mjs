// End to end in a real Pi session, driven by a scripted model (no network).
// Runs only when PI names the pi executable and a real ts-crap is available;
// the MCP test adds a C# change when a real dotnet-crap is available too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realDotnetScanner, realScanner, repo } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "pi", "run.sh");
const mcpRunner = path.join(here, "pi", "run-mcp.sh");
const skip = !process.env.PI ? "set PI to the pi executable" : !realScanner ? "needs a real ts-crap (TS_CRAP_TEST_BIN)" : false;

function runPi(root, args, env, { script = runner, tool = "changed_risk" } = {}) {
  return new Promise((resolve, reject) => {
    execFile(script, [root, JSON.stringify(args)], { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`pi failed: ${error.message}\n${stderr}`));
      const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const end = events.find(event => event.type === "tool_execution_end" && event.toolName === tool);
      if (!end) return reject(new Error(`${tool} was never executed:\n${stdout.slice(0, 2000)}`));
      resolve(end);
    });
  });
}

const BASE = "export function price(qty: number, member: boolean): number {\n  return qty * 10;\n}\n\nexport function label(n: number): string {\n  return `#${n}`;\n}\n";
const CHANGED = "export function price(qty: number, member: boolean): number {\n  let total = qty * 10;\n  if (member) total *= 0.9;\n" +
  "  if (qty > 100) total -= 50;\n  else if (qty > 10) total -= 5;\n  if (total < 0) total = 0;\n  return total;\n}\n\n" +
  "export function label(n: number): string {\n  return `#${n}`;\n}\n";

test("Pi session: the tool loads, runs on the session's repository and returns the ranked answer", { skip }, async (t) => {
  const r = await repo({ "src/price.ts": BASE });
  await r.write("src/price.ts", CHANGED);
  t.after(() => r.cleanup());
  // NODE_TEST_CONTEXT would make Pi (a Node program) talk to this test runner instead of its own stdout.
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const env = { ...base, PI_OFFLINE: "1", CRAP_AGENT_TS_CRAP: realScanner };

  const ok = await runPi(r.root, { limit: 5 }, env);
  assert.equal(ok.isError, false);
  const answer = ok.result.structuredContent;
  assert.equal(answer.schema, "crap-agent-tools/changed-risk/v2");
  assert.deepEqual(answer.functions.map(f => [f.path, f.name, f.line, f.complexity, f.crap, f.failsGate, f.evidence]),
    [["src/price.ts", "price", 1, 5, 30, true, "not_measured"]]);
  assert.match(ok.result.content[0].text, /^ts-crap \d+\.\d+\.\d+ \(TypeScript, threshold 10, coverage not supplied\); base HEAD/);
  assert.match(ok.result.content[0].text, /1\. FAIL src\/price\.ts:1 price - CRAP 30/);

  const unknown = await runPi(r.root, { limit: 5, root: "/" }, env);
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown.result), /root/);

  const badLimit = await runPi(r.root, { limit: 0 }, env);
  assert.equal(badLimit.isError, true);

  const { CRAP_AGENT_TS_CRAP, ...noScanner } = env;
  const missing = await runPi(r.root, {}, { ...noScanner, PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin" });
  assert.equal(missing.isError, true);
  assert.equal(missing.result.structuredContent.error.kind, "scanner_not_found");
  assert.match(missing.result.content[0].text, /ts-crap was not found on PATH/);
});

const CS_BASE = "namespace Demo;\n\npublic class Calc\n{\n    public int Price(int qty)\n    {\n        return qty * 10;\n    }\n}\n";
const CS_CHANGED = CS_BASE.replace("        return qty * 10;\n", "        if (qty > 10) return qty * 9;\n        return qty * 10;\n");

test("Pi session over MCP: Pi's own MCP client reaches the server and gets the same answer", { skip }, async (t) => {
  const r = await repo({ "src/price.ts": BASE, "src/Calc.cs": CS_BASE });
  await r.write("src/price.ts", CHANGED);
  if (realDotnetScanner) await r.write("src/Calc.cs", CS_CHANGED);
  t.after(() => r.cleanup());
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const env = { ...base, PI_OFFLINE: "1", CRAP_AGENT_TS_CRAP: realScanner, ...(realDotnetScanner ? { CRAP_AGENT_DOTNET_CRAP: realDotnetScanner } : {}) };
  const direct = await runPi(r.root, { limit: 5 }, env);
  const viaMcp = await runPi(r.root, { limit: 5 }, env, { script: mcpRunner, tool: "mcp__crap__changed_risk" });
  assert.equal(viaMcp.isError, false);
  assert.equal(viaMcp.result.content[0].text, direct.result.content[0].text);
  assert.deepEqual(viaMcp.result.structuredContent.structuredContent, direct.result.structuredContent);
  if (realDotnetScanner) {
    assert.deepEqual(direct.result.structuredContent.functions.map(f => [f.language, f.name, f.crap]), [["typescript", "price", 30], ["csharp", "Price", 6]]);
  }
});
