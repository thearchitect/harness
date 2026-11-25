// ask_user is pi-ask-user's (0.17.2): its parameters, description, guidelines and renderers, as
// its extension registers the tool. Only the asking moves to the clients: the call goes to them as
// the `questions` interaction, and the one who answers returns the tool result pi-ask-user makes —
// the TUI by running pi-ask-user's own prompt (tui/src/ask-user.ts), the app by drawing its own
// (client/src/ask-user.ts builds the same result).

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type { AskUserResult } from "#protocol/interactions.ts";
import type { Interactions } from "../host.ts";

/** pi-ask-user's tool definition, captured from its extension (it registers nothing else that harness uses). */
async function loadAskUserTool(): Promise<ToolDefinition> {
  const jiti = createJiti(import.meta.url);
  const module = (await jiti.import(import.meta.resolve("pi-ask-user/index.ts"))) as { default: (pi: ExtensionAPI) => void };
  let tool: ToolDefinition | undefined;
  const pi = new Proxy(
    {
      registerTool: (definition: ToolDefinition) => {
        tool = definition;
      },
      events: { on: () => () => undefined, emit: () => undefined },
    },
    {
      get(target, property) {
        return property in target ? target[property as keyof typeof target] : () => undefined;
      },
    },
  ) as unknown as ExtensionAPI;
  module.default(pi);
  if (tool === undefined) {
    throw new Error("pi-ask-user registered no ask_user tool");
  } else {
    return tool;
  }
}

export const piAskUserTool: ToolDefinition = await loadAskUserTool();

/** The result of a dismissed question, as pi-ask-user words it. */
function cancelled(params: Record<string, unknown>): AskUserResult {
  return params.questions !== undefined && params.questions !== null
    ? { content: [{ type: "text", text: "User cancelled the questions" }], details: { kind: "batch", questions: [], answers: [], cancelled: true } }
    : { content: [{ type: "text", text: "User cancelled the question" }], details: { question: params.question, options: [], response: null, cancelled: true } };
}

export function registerAskUser(pi: ExtensionAPI, interactions: Interactions): void {
  pi.registerTool({
    ...piAskUserTool,
    async execute(toolCallId, params, signal) {
      const call = params as Record<string, unknown>;
      const answer = await interactions.ask("questions", { params: call }, { signal, toolCallId });
      if (answer === undefined || "cancelled" in answer) {
        return cancelled(call) as never;
      } else if ("error" in answer) {
        throw new Error(answer.error);
      } else {
        return answer.result as never;
      }
    },
  });
}
