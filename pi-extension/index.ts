import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INPUT_SCHEMA, OUTPUT_SCHEMA, PROMPT_GUIDELINES, TOOL_DESCRIPTION, TOOL_LABEL, TOOL_NAME, callTool } from "../core/surface.mjs";

// One read-only tool over the shared core. The project root is the session's
// working directory; the scanner executable comes from the environment
// (CRAP_AGENT_TS_CRAP, or ts-crap on PATH), never from tool arguments.
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: TOOL_DESCRIPTION,
    promptSnippet: "Rank changed TypeScript functions by CRAP score and name the missing tests",
    promptGuidelines: PROMPT_GUIDELINES,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: INPUT_SCHEMA as any,
    outputSchema: OUTPUT_SCHEMA as any,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await callTool(params, { root: ctx.cwd, signal });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.structured,
        structuredContent: result.structured,
        isError: result.isError,
      };
    },
  });
}
