// The title on a dialog's frame (the TUI's DialogFrame, the app's Dialog), the same in every client:
// what is asked, and who asks when a subagent does.

import type { InteractionRequest } from "#protocol/interactions.ts";

export function interactionTitle(request: InteractionRequest, from?: string): string {
  const asks = from !== undefined ? `subagent ${from} asks · ` : "";
  switch (request.kind) {
    case "gate":
      return `${asks}${request.payload.title}${request.payload.by !== undefined ? ` — ${request.payload.by}` : ""}`;
    case "secret":
      return `${asks}secret for the agent: ${request.payload.name}`;
    case "questions":
      return `${asks}question`;
    case "choice":
      return `${asks}choose`;
    case "pi-dialog":
      return `${asks}${request.payload.method}`;
    case "login":
      return `${asks}${request.payload.title}`;
    case "display":
      return `${asks}display`;
    default:
      throw new Error(`unknown interaction: ${JSON.stringify(request satisfies never)}`);
  }
}
