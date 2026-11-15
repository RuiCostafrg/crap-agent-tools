// Test-only Pi extension: a scripted "model" (Pi's own faux provider) that
// calls changed_risk (or CRAP_AGENT_PI_TOOL) once with the arguments in CRAP_AGENT_PI_ARGS, then
// replies with the tool's text result verbatim. Lets a real Pi session run
// the tool end to end with no network and no model credentials.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "scripted", api: "scripted", models: [{ id: "scripted", contextWindow: 200000, maxTokens: 8192 }] });
  const args = JSON.parse(process.env.CRAP_AGENT_PI_ARGS ?? "{}");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(process.env.CRAP_AGENT_PI_TOOL ?? "changed_risk", args, { id: "call-1" }), { stopReason: "toolUse" }),
    (context) => {
      const result = [...context.messages].reverse().find((message: any) => message.role === "toolResult") as any;
      const text = result?.content?.find((block: any) => block.type === "text")?.text ?? "(no tool result)";
      return fauxAssistantMessage(fauxText(`TOOL RESULT${result?.isError ? " (error)" : ""}:\n${text}`));
    },
  ]);
  pi.registerProvider(faux.provider);
}
