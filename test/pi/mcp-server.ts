// Test-only Pi extension: registers this repository's MCP server for the
// current session only (no mcp.json is written), as server "crap".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp-server/server.mjs");

export default function (pi: ExtensionAPI) {
  pi.registerMcpServer("crap", { command: process.execPath, args: [server], exposure: "direct", env: { CRAP_AGENT_TS_CRAP: process.env.CRAP_AGENT_TS_CRAP ?? "" } } as any);
}
