// The node protocol: a client (TUI, app, test driver) and a node (or a hub routing to nodes) over
// one connection — a unix socket, a WebSocket, or in-process. Frames are JSONL objects keyed by
// `k`. Control requests carry an id and get one response; HAP records of attached agents travel
// in `hap` frames addressed by agent id (and node, through a hub).

import type { ProtocolError } from "./errors.ts";
import type { HapRecord } from "./hap.ts";
import type { RunMode } from "./state.ts";

/** How much of an agent a client follows: the whole stream, or its summary only. */
export type AttachLevel = "full" | "summary";

/** What the node computes from an agent's stream for every client that follows it. */
export type AgentSummary = {
  status: "idle" | "running" | "waiting" | "error";
  mode: RunMode;
  title: string;
  /** Open operator interactions. */
  waiting: number;
  tasks: { running: number; failed: number };
  /** Outcome of the last finished run: drives the ✓/✗ glyphs until the client has seen it. */
  lastOutcome?: "ok" | "error";
  /** When the last run finished or the last interaction opened (ms since epoch). */
  lastActivity: number;
  costUsd: number;
};

export type AgentInfo = {
  id: string;
  node: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  name?: string;
  /** Agent id of the parent of a subagent. */
  parent?: string;
  startedAt: number;
  summary: AgentSummary;
};

export type SessionListItem = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  modified: number;
  messageCount: number;
  firstMessage?: string;
  /** The agent serving it now, if any. */
  agent?: string;
};

export type FileItem = { name: string; path: string; kind: "file" | "dir" | "link"; size: number };

export type NodeInfo = { name: string; online: boolean; roles: string[] };

/** Control operations and their argument and result types. */
export type NodeOps = {
  nodes_list: { args: Record<string, never>; result: { nodes: NodeInfo[] } };
  sessions_list: { args: { cwd?: string }; result: { sessions: SessionListItem[] } };
  agents_list: { args: Record<string, never>; result: { agents: AgentInfo[] } };
  agent_start: { args: { cwd: string; sessionFile?: string; parent?: string }; result: { agent: AgentInfo } };
  agent_attach: { args: { agent: string; level: AttachLevel }; result: { agent: AgentInfo } };
  agent_detach: { args: { agent: string }; result: Record<string, never> };
  agent_close: { args: { agent: string }; result: Record<string, never> };
  files_list: { args: { path: string }; result: { path: string; items: FileItem[] } };
  files_get: { args: { path: string }; result: { path: string; base64: string } };
  files_put: { args: { path: string; base64: string }; result: { path: string } };
  settings_get: { args: Record<string, never>; result: { settings: Record<string, unknown> } };
  settings_set: { args: { key: string; value: unknown }; result: { settings: Record<string, unknown> } };
};

export type NodeOp = keyof NodeOps;

export const NODE_OPS: readonly NodeOp[] = [
  "nodes_list",
  "sessions_list",
  "agents_list",
  "agent_start",
  "agent_attach",
  "agent_detach",
  "agent_close",
  "files_list",
  "files_get",
  "files_put",
  "settings_get",
  "settings_set",
];

export type NodeEvent =
  | { ev: "agents"; agents: AgentInfo[] }
  | { ev: "summary"; agent: string; summary: AgentSummary }
  | { ev: "agent_exited"; agent: string; code: number | null; error?: string }
  | { ev: "settings"; settings: Record<string, unknown> };

export type ClientFrame =
  | { k: "hello"; protocol: number; client: string; token?: string }
  | { k: "req"; id: string; node?: string; op: NodeOp; args: unknown }
  | { k: "hap"; node?: string; agent: string; rec: HapRecord };

export type NodeFrame =
  | { k: "welcome"; protocol: number; harness: string; node: string; user: string }
  | { k: "refused"; error: ProtocolError }
  | { k: "res"; id: string; ok: true; data: unknown }
  | { k: "res"; id: string; ok: false; error: ProtocolError }
  | { k: "evt"; node: string; event: NodeEvent }
  | { k: "hap"; node: string; agent: string; rec: HapRecord };
