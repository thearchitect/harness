/**
 * ask_secret: the operator types a secret into a masked `secret` interaction; the value never
 * reaches the model (secrets.ts keeps it for the session and masks tool results). The model moves
 * it into cage itself when it must outlive the session, without reading it.
 */

import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { secretValueProblem } from "#protocol/interactions.ts";
import type { Interactions } from "../host.ts";
import { SECRET_MASK, secretNameProblem, sessionSecrets } from "./secrets.ts";

export function registerAskSecret(pi: ExtensionAPI, interactions: Interactions): void {
  pi.registerTool({
    name: "ask_secret",
    label: "Ask secret",
    description: [
      "Ask the operator for a secret (token, password, API key) in a masked dialog.",
      "The value never reaches you: it is kept in memory for this session only (lost when the agent exits),",
      "every bash command of the session gets it as the environment variable `name`,",
      `and tool results show it as ${SECRET_MASK}. Works in PLAN and BUILD: nothing is written to disk.`,
      "Call it only on the operator's explicit command.",
    ].join(" "),
    promptSnippet: "Get a secret from the operator into a bash environment variable without seeing it",
    promptGuidelines: [
      "Call ask_secret only when the operator explicitly tells you to request secrets, never on your own initiative. When a task needs a secret only the operator has (token, password, API key), name it in the plan (variable name, what it is, where to get it) and wait for the operator's command; never ask for its value in chat.",
      "Use a secret from ask_secret only as `$NAME` inside bash commands; never print it.",
      "When a secret from ask_secret must outlive the session, store it in cage in BUILD without reading it: printf '%s' \"$NAME\" | cage set -stdin <ref> NAME (the cage skill).",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "The environment variable for bash commands: A-Z, 0-9 and _, e.g. GITHUB_TOKEN" }),
      description: Type.String({ description: "What the operator should enter and where to get it" }),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const nameProblem = secretNameProblem(params.name);
      if (nameProblem !== undefined) {
        throw new Error(nameProblem);
      } else if (params.description.trim() === "") {
        throw new Error("description is required: say what to enter and where to get it");
      } else {
        const sessionId = ctx.sessionManager.getSessionId();
        const answer = await interactions.ask(
          "secret",
          { name: params.name, description: params.description.trim(), replaces: sessionSecrets.has(sessionId, params.name) },
          { signal, toolCallId },
        );
        if (answer === undefined || "cancelled" in answer) {
          throw new Error("The operator declined to enter the secret.");
        } else {
          const valueProblem = secretValueProblem(answer.value);
          if (valueProblem !== undefined) {
            throw new Error(`The operator's value was refused: ${valueProblem}`);
          } else {
            sessionSecrets.set(sessionId, params.name, answer.value);
            return {
              content: [{
                type: "text",
                text: `Stored as $${params.name} for bash commands of this session (memory only, lost when the agent exits). Tool results show it as ${SECRET_MASK}.`,
              }],
              details: { name: params.name },
            };
          }
        }
      }
    },
  });

  // Every tool result, nested ones included, reaches the model and the session with the session's secrets masked.
  pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
    const masked = sessionSecrets.mask(ctx.sessionManager.getSessionId(), {
      content: event.content,
      structuredContent: event.structuredContent,
      details: event.details,
    });
    if (masked.changed) {
      return masked.value;
    } else {
      return undefined; // no secret in this result
    }
  });
}
