// HAP — the harness agent protocol: one ordered JSONL stream between a harness-agent and the node
// that runs it (stdio), forwarded per client channel. It is a superset of pi's RPC: pi commands,
// responses, session events and extension_ui_* records pass unchanged; harness adds the records
// below. pi's shapes are documented by pi (docs/rpc.md, docs/rpc-commands.md, docs/json.md);
// harness keeps them as opaque objects here and types them in the client.

import type { InteractionCloseReason, InteractionRequest } from "./interactions.ts";
import type { HarnessState, RunMode, Variant } from "./state.ts";
import type { ProtocolError } from "./errors.ts";

/** A pi RPC command, response, session event or extension_ui record. */
export type PiRecord = { type: string; id?: string; [field: string]: unknown };

export type ImageAttachment = { type: "image"; data: string; mimeType: string };

/** Requests a client sends to the agent; each gets one harness_response with the same id. */
export type HapRequest =
  | { type: "harness_snapshot"; id: string; limit: number }
  | { type: "harness_entries_before"; id: string; cursor: string; limit: number }
  | { type: "harness_prompt"; id: string; text: string; mode?: RunMode; images?: ImageAttachment[] }
  /** `model`: a model reference (model-ref.ts) the session selects and follows. */
  | { type: "harness_set"; id: string; variant?: Variant; madness?: boolean; implementer?: string; model?: string }
  | { type: "harness_interrupt"; id: string; reason: string }
  | { type: "harness_interaction_response"; id: string; interactionId: string; answer: unknown }
  | { type: "harness_task_stop"; id: string; taskId: string }
  | { type: "harness_task_input"; id: string; taskId: string; data: string }
  | { type: "harness_task_output"; id: string; taskId: string; offset: number; limit: number }
  | { type: "harness_subagent_send"; id: string; session: string; text: string }
  | { type: "harness_complete"; id: string; kind: "path" | "file"; prefix: string }
  /** Keys for a bridged component (as the terminal sends them), and the width it is drawn at. */
  | { type: "harness_component_input"; id: string; componentId: string; data: string }
  | { type: "harness_component_resize"; id: string; componentId: string; width: number }
  /** The agent's dependencies report (bundle, Claude Code, subagent profiles, bundled versions) → { text }. */
  | { type: "harness_report"; id: string }
  /** The subagent profiles this session may call → { profiles, problems }. */
  | { type: "harness_subagents"; id: string }
  /** Providers one can log in to on the agent's machine → { providers: LoginProvider[] }. */
  | { type: "harness_login_providers"; id: string }
  /** Logs in on the agent's machine; its steps are interactions; answers when done → {}. */
  | { type: "harness_login"; id: string; provider: string; authType: "oauth" | "api_key" }
  | { type: "harness_logout"; id: string; provider: string };

export type LoginProvider = { id: string; name: string; authType: "oauth" | "api_key"; configured: boolean; subscription: boolean };

/** A subagent profile as clients list it. */
export type SubagentProfileView = { name: string; description: string; engine: "harness" | "claude"; source: string; model?: string; resolved?: string; mode: string; dir: string };

export type HapRequestType = HapRequest["type"];

export const HAP_REQUEST_TYPES: readonly HapRequestType[] = [
  "harness_snapshot",
  "harness_entries_before",
  "harness_prompt",
  "harness_set",
  "harness_interrupt",
  "harness_interaction_response",
  "harness_task_stop",
  "harness_task_input",
  "harness_task_output",
  "harness_subagent_send",
  "harness_complete",
  "harness_component_input",
  "harness_component_resize",
  "harness_report",
  "harness_subagents",
  "harness_login_providers",
  "harness_login",
  "harness_logout",
];

/** A component of an extension (ctx.ui.custom) drawn in the agent and shown by terminal clients. */
export type BridgedComponent = { componentId: string; overlay: boolean; lines: string[] };

export function isHapRequest(record: { type?: unknown }): record is HapRequest {
  return typeof record.type === "string" && (HAP_REQUEST_TYPES as readonly string[]).includes(record.type);
}

/** The answer to a HapRequest. */
export type HapResponse = { type: "harness_response"; id: string } & ({ ok: true; data?: unknown } | { ok: false; error: ProtocolError });

/** What the agent is doing right now, for the clients' status glyphs and summaries. */
export type AgentActivity = "idle" | "running" | "compacting";

/** pi's view of the session, as `get_state` reports it, plus what the footer needs. */
export type SessionView = {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  model?: { provider: string; id: string; contextWindow?: number };
  thinkingLevel: string;
  activity: AgentActivity;
  queue: { steering: string[]; followUp: string[] };
  usage: { costUsd: number; contextTokens?: number; contextPercent?: number };
};

export type SnapshotData = {
  /** The newest `limit` session entries of the current branch, oldest first. */
  entries: unknown[];
  /** Pass to harness_entries_before for the entries before these; absent at the beginning. */
  cursor?: string;
  /** The assistant message being streamed and the tool executions in flight, if a run is on. */
  partial?: { message?: unknown; tools: { toolCallId: string; toolName: string; args: unknown; partialResult?: unknown }[] };
  session: SessionView;
  state: HarnessState;
  interactions: InteractionRequest[];
  status: Record<string, string>;
  /** Open bridged components, for clients that can draw them. */
  components?: BridgedComponent[];
};

export type EntriesBeforeData = { entries: unknown[]; cursor?: string };

/** Records the agent emits besides pi's own. */
export type HapEvent =
  | { type: "harness_hello"; protocol: number; harness: string; session: SessionView }
  | HapResponse
  | { type: "harness_state"; state: HarnessState }
  | { type: "harness_session"; session: SessionView }
  | { type: "harness_interaction_request"; request: InteractionRequest }
  | { type: "harness_interaction_closed"; interactionId: string; reason: InteractionCloseReason }
  | { type: "harness_task_output"; taskId: string; offset: number; chunk: string }
  | { type: "harness_ui"; method: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "harness_ui"; method: "status"; key: string; text?: string }
  | { type: "harness_ui"; method: "widget"; key: string; lines?: string[] }
  | { type: "harness_ui"; method: "editor_text"; text: string }
  | { type: "harness_ui"; method: "title"; title: string }
  | { type: "harness_component_open"; componentId: string; overlay: boolean }
  | { type: "harness_component_render"; componentId: string; lines: string[] }
  | { type: "harness_component_close"; componentId: string };

/**
 * Node → agent: the clients attached in full; and the node's frames for the agent's own connection
 * to its node (an agent is a client of its node for its subagents).
 */
export type NodeToAgentRecord = { type: "harness_clients"; componentBridge: number } | { type: "harness_node"; frame: unknown };

/** Agent → node: a frame of the agent's own client connection to its node (node.ts ClientFrame). */
export type AgentToNodeRecord = { type: "harness_node"; frame: unknown };

export type HapRecord = HapRequest | HapEvent | AgentToNodeRecord | NodeToAgentRecord | PiRecord;
