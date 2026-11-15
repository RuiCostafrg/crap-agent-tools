#!/usr/bin/env node
// MCP stdio server exposing the same single tool as the Pi extension.
// A thin adapter: newline-delimited JSON-RPC 2.0 on stdin/stdout, no SDK.
// The project root is CRAP_AGENT_ROOT (absolute) or the directory the client
// starts the server in. Nothing but protocol messages is written to stdout.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { INPUT_SCHEMA, OUTPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_LABEL, TOOL_NAME, callTool } from "../core/surface.mjs";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"]; // structured tool output needs 2025-06-18 or later
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const TOOL = {
  name: TOOL_NAME,
  title: TOOL_LABEL,
  description: TOOL_DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: { title: TOOL_LABEL, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** Create a server bound to `send(message)`; returns { handle(line), close() }. */
export function createServer({ send, root, env = process.env, call = callTool }) {
  const inFlight = new Map(); // request id (JSON) -> { controller, done }
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function toolsCall(id, params) {
    if (params?.name !== TOOL_NAME) return fail(id, -32602, `Unknown tool: ${String(params?.name).slice(0, 100)}`);
    if (inFlight.size >= MAX_IN_FLIGHT) return fail(id, -32000, `At most ${MAX_IN_FLIGHT} calls may run at once.`);
    const key = JSON.stringify(id);
    const controller = new AbortController();
    const entry = { controller };
    inFlight.set(key, entry);
    entry.done = (async () => {
      try {
        const result = await call(params.arguments, { root, env, signal: controller.signal });
        // A cancelled request gets no response, as the protocol requires.
        if (!controller.signal.aborted) reply(id, { content: [{ type: "text", text: result.text }], structuredContent: result.structured, isError: result.isError });
      } finally {
        inFlight.delete(key);
      }
    })();
  }

  function handle(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return fail(null, -32600, "Message too large.");
    let message;
    try { message = JSON.parse(line); } catch { return fail(null, -32700, "Parse error."); }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return fail(message?.id ?? null, -32600, "Invalid request.");
    }
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) {
      if (method === "notifications/cancelled") inFlight.get(JSON.stringify(params?.requestId))?.controller.abort();
      return; // other notifications (initialized, roots changes, …) need nothing
    }
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "crap-agent-tools", title: "CRAP agent tools", version },
        });
      }
      case "ping": return reply(id, {});
      case "tools/list": return reply(id, { tools: [TOOL] });
      case "tools/call": return toolsCall(id, params);
      default: return fail(id, -32601, `Method not found: ${method.slice(0, 100)}`);
    }
  }

  async function close() {
    for (const entry of inFlight.values()) entry.controller.abort();
    await Promise.allSettled([...inFlight.values()].map(entry => entry.done));
  }
  return { handle, close };
}

function main() {
  const root = process.env.CRAP_AGENT_ROOT || process.cwd();
  if (!path.isAbsolute(root)) {
    process.stderr.write("CRAP_AGENT_ROOT must be an absolute path.\n");
    process.exit(2);
  }
  const server = createServer({ root, send: message => process.stdout.write(JSON.stringify(message) + "\n") });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => server.handle(line));
  input.on("close", () => server.close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
