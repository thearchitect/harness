// The node protocol: a client (TUI, app, test driver) and a node (or a hub routing to nodes) over
// one connection — a unix socket, a WebSocket, or in-process. Frames are JSONL objects keyed by
// `k`. Control requests carry an id and get one response; HAP records of attached agents travel
// in `hap` frames addressed by agent id (and node, through a hub).

import type { ProtocolError } from "./errors.ts";
import type { HapRecord, SnapshotData } from "./hap.ts";
import type { RunMode, SubagentLaunch } from "./state.ts";

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
  /** A subagent's profile; `background` ones outlive their parent. */
  subagent?: { profile: string; background: boolean; depth: number };
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
  /** `subagent`: started by an agent for its subagent (the node sets the parent and the depth). */
  agent_start: { args: { cwd: string; sessionFile?: string; subagent?: SubagentLaunch; background?: boolean }; result: { agent: AgentInfo } };
  /** At the full level the answer carries the snapshot; the stream continues after it. */
  agent_attach: { args: { agent: string; level: AttachLevel }; result: { agent: AgentInfo; snapshot?: SnapshotData } };
  agent_detach: { args: { agent: string }; result: Record<string, never> };
  agent_close: { args: { agent: string }; result: Record<string, never> };
  files_list: { args: { path: string }; result: { path: string; items: FileItem[] } };
  files_get: { args: { path: string }; result: { path: string; base64: string } };
  files_put: { args: { path: string; base64: string }; result: { path: string } };
  /** A file the operator hands to a session (dropped, shared, picked): kept in the node's uploads, its path returned for `@path`. */
  files_upload: { args: { name: string; base64: string }; result: { path: string } };
  /** Speech to text on the node, with its user's OpenAI login (the app's voice input). */
  transcribe: { args: { base64: string; mime: string }; result: { text: string } };
  /** The node's event log, newest last: for its own user, and on a hub for the hub's admins. */
  logs_tail: { args: { lines?: number }; result: { lines: string[] } };
  settings_get: { args: Record<string, never>; result: { settings: Record<string, unknown> } };
  /** `ifRevision`: the revision (settingRevision) of the value the change was made from; another one is a `conflict`. */
  settings_set: { args: { key: string; value: unknown; ifRevision?: string }; result: { settings: Record<string, unknown> } };
  /** A theme's colors as hex (pi's tokens plus pageBg and cardBg), for clients that draw it themselves. */
  theme_get: { args: { name?: string }; result: ThemeColors };
  /** Stops every agent and its processes and starts the node again: in the same process when a client holds it, by its supervisor when it is a service. */
  node_restart: { args: Record<string, never>; result: Record<string, never> };
};

/** Who runs a node: a client process (a TUI or web-app window holds it) or a service (`harness node`). */
export type NodeHost = "client" | "service";

/** A resolved theme: `appearance`, pi's color tokens and the page colors, all hex. */
export type ThemeColors = { name: string; appearance: "dark" | "light"; colors: Record<string, string>; names: string[] };

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
  "files_upload",
  "transcribe",
  "logs_tail",
  "settings_get",
  "settings_set",
  "theme_get",
  "node_restart",
];

export type NodeEvent =
  | { ev: "agents"; agents: AgentInfo[] }
  | { ev: "summary"; agent: string; summary: AgentSummary }
  | { ev: "agent_exited"; agent: string; code: number | null; error?: string }
  | { ev: "settings"; settings: Record<string, unknown> }
  /** A hub's nodes changed: one came online or went offline. */
  | { ev: "nodes"; nodes: NodeInfo[] }
  /** A node behind a hub refused this client's channel (a protocol version mismatch). */
  | { ev: "refused"; error: ProtocolError };

/** What a client can draw besides the protocol's typed data: "component-bridge" — ANSI lines of an agent's pi-tui components (terminal clients). */
export type ClientCapability = "component-bridge";

export type ClientFrame =
  | { k: "hello"; protocol: number; client: string; token?: string; capabilities?: ClientCapability[] }
  | { k: "req"; id: string; node?: string; op: NodeOp; args: unknown }
  | { k: "hap"; node?: string; agent: string; rec: HapRecord };

/**
 * The link between a node and a hub (the node connects, with its key as the hello token). The hub
 * carries its clients' frames for the node, each client a channel `conn` with its hub user; the
 * node answers on the same channel. The node sees each channel as one client connection.
 */
export type HubToNodeFrame =
  | Extract<NodeFrame, { k: "welcome" } | { k: "refused" }>
  | { k: "route"; conn: string; user: string; frame: ClientFrame }
  | { k: "route_close"; conn: string };

export type NodeToHubFrame = Extract<ClientFrame, { k: "hello" }> | { k: "route"; conn: string; frame: NodeFrame };

/** What carries a client's frames to a node: a unix socket, a WebSocket, an in-process node. */
export interface Transport {
  send(frame: ClientFrame): void;
  onFrame(listener: (frame: NodeFrame) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

export type NodeFrame =
  | { k: "welcome"; protocol: number; harness: string; node: string; user: string; host: NodeHost; pid: number }
  | { k: "refused"; error: ProtocolError }
  | { k: "res"; id: string; ok: true; data: unknown }
  | { k: "res"; id: string; ok: false; error: ProtocolError }
  | { k: "evt"; node: string; event: NodeEvent }
  | { k: "hap"; node: string; agent: string; rec: HapRecord };
