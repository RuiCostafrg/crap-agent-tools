// MCP stdio server at the protocol level: the real process over pipes, and the
// in-process server for cancellation and limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../mcp-server/server.mjs";
import { INPUT_SCHEMA, OUTPUT_SCHEMA, TOOL_NAME } from "../core/surface.mjs";
import { pathWith, realScanner, repo } from "./helpers.mjs";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp-server", "server.mjs");

/** Start the server process; `request(message)` resolves with the reply to its id. */
function startServer(env, cwd) {
  const child = spawn(process.execPath, [serverPath], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(), stray = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); // every stdout line must be JSON
      buffer = buffer.slice(index + 1);
      const resolve = waiting.get(JSON.stringify(message.id));
      if (resolve) { waiting.delete(JSON.stringify(message.id)); resolve(message); } else stray.push(message);
    }
  });
  const send = message => child.stdin.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
  const request = message => new Promise(resolve => { waiting.set(JSON.stringify(message.id), resolve); send(message); });
  const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
  return { send, request, stray, exited, end: () => child.stdin.end() };
}

test("MCP process: handshake, tool listing, errors and a tool call", async (t) => {
  const r = await repo({ "src/a.ts": "export function a(x: number) {\n  return x;\n}\n" });
  t.after(() => r.cleanup());
  await r.write("src/a.ts", "export function a(x: number) {\n  if (x > 1) return x;\n  return -x;\n}\n");
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const env = { ...base, PATH: pathWith(), ...(realScanner ? { CRAP_AGENT_TS_CRAP: realScanner } : {}) };
  const server = startServer(env, r.root);

  const init = await server.request({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "crap-agent-tools");
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const future = await server.request({ jsonrpc: "2.0", id: "v", method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(future.result.protocolVersion, "2025-11-25", "an unknown version gets the newest supported one");

  const list = await server.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.result.tools.length, 1);
  const [tool] = list.result.tools;
  assert.equal(tool.name, TOOL_NAME);
  assert.deepEqual(tool.inputSchema, INPUT_SCHEMA);
  assert.deepEqual(tool.outputSchema, OUTPUT_SCHEMA);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);

  assert.deepEqual((await server.request({ jsonrpc: "2.0", id: 3, method: "ping" })).result, {});
  assert.equal((await server.request({ jsonrpc: "2.0", id: 4, method: "resources/list" })).error.code, -32601);
  assert.equal((await server.request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other" } })).error.code, -32602);

  const bad = await server.request({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: TOOL_NAME, arguments: { limit: 0 } } });
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.structuredContent.error.kind, "invalid_argument");
  assert.equal(bad.result.content[0].type, "text");

  const call = await server.request({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: TOOL_NAME, arguments: {} } });
  if (realScanner) {
    assert.equal(call.result.isError, false);
    const answer = call.result.structuredContent;
    assert.deepEqual(answer.functions.map(f => [f.path, f.name, f.complexity, f.crap]), [["src/a.ts", "a", 2, 6]]);
    assert.equal(call.result.content[0].text.split("\n")[2], `1. ok src/a.ts:1 a - CRAP 6, complexity 2, coverage 0%. ${answer.functions[0].missing}`);
  } else {
    assert.equal(call.result.structuredContent.error.kind, "scanner_not_found");
  }

  server.send("{not json");
  server.send(JSON.stringify({ jsonrpc: "1.0", id: 9, method: "ping" }));
  server.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown" }));
  assert.deepEqual((await server.request({ jsonrpc: "2.0", id: 10, method: "ping" })).result, {});
  assert.deepEqual(server.stray.map(m => [m.id, m.error?.code]), [[null, -32700], [9, -32600]], "notifications get no reply");

  server.end();
  assert.equal(await server.exited, 0);
});

test("MCP in process: cancellation suppresses the reply and aborts the analysis; calls are capped", async () => {
  const sent = [], signals = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const call = async (_args, { signal }) => {
    signals.push(signal);
    await gate;
    return { text: "done", structured: { schema: "s" }, isError: false };
  };
  const server = createServer({ send: m => sent.push(m), root: "/repo", env: {}, call });
  const callMessage = id => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: TOOL_NAME, arguments: {} } });

  for (const id of [1, 2, 3, 4]) server.handle(callMessage(id));
  server.handle(callMessage(5));
  assert.deepEqual(sent.map(m => [m.id, m.error?.code]), [[5, -32000]]);

  server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "user" } }));
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[0].aborted, false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.slice(1).map(m => m.id).sort(), [1, 3, 4], "the cancelled request gets no response");
  assert.deepEqual(sent[1].result, { content: [{ type: "text", text: "done" }], structuredContent: { schema: "s" }, isError: false });

  server.handle("x".repeat(1024 * 1024 + 1));
  assert.equal(sent.at(-1).error.code, -32600);
  await server.close();
});
