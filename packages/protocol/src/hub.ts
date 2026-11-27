// The hub protocol: a client (TUI, app, test driver) and a hub over one connection — a unix
// socket, a WebSocket, or in-process. Frames are JSONL objects keyed by `k`. Control requests carry
// an id and get one response; HAP records of attached agents travel in `hap` frames addressed by
// agent id.

import type { ProtocolError } from "./errors.ts";
import type { HapRecord, SnapshotData } from "./hap.ts";
import type { RunMode, SubagentLaunch } from "./state.ts";

/** How much of an agent a client follows: the whole stream, or its summary only. */
export type AttachLevel = "full" | "summary";

/** What the hub computes from an agent's stream for every client that follows it. */
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
  hub: string;
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
  /** When the session was created (ms). */
  created: number;
  modified: number;
  messageCount: number;
  firstMessage?: string;
  /** The agent serving it now, if any. */
  agent?: string;
};

export type FileItem = { name: string; path: string; kind: "file" | "dir" | "link"; size: number };

/** Control operations and their argument and result types. */
export type HubOps = {
  sessions_list: { args: { cwd?: string }; result: { sessions: SessionListItem[] } };
  /**
   * A stored session's entries without its agent, as harness_snapshot and harness_entries_before
   * give them (the current branch, the newest `limit` before `cursor`); `mtime` tells whether the
   * file changed since.
   */
  session_read: { args: { file: string; cursor?: string; limit?: number }; result: { entries: unknown[]; cursor?: string; mtime: number } };
  agents_list: { args: Record<string, never>; result: { agents: AgentInfo[] } };
  /** `subagent`: started by an agent for its subagent (the hub sets the parent and the depth). */
  agent_start: { args: { cwd: string; sessionFile?: string; subagent?: SubagentLaunch; background?: boolean }; result: { agent: AgentInfo } };
  /** At the full level the answer carries the snapshot; the stream continues after it. */
  agent_attach: { args: { agent: string; level: AttachLevel }; result: { agent: AgentInfo; snapshot?: SnapshotData } };
  agent_detach: { args: { agent: string }; result: Record<string, never> };
  agent_close: { args: { agent: string }; result: Record<string, never> };
  files_list: { args: { path: string }; result: { path: string; items: FileItem[] } };
  /** The directories in a directory of the hub's machine, for choosing where a session starts: by name, each saying whether it has directories itself. */
  dirs_list: { args: { path: string; hidden?: boolean }; result: { path: string; parent: string | undefined; home: string; dirs: DirItem[] } };
  files_get: { args: { path: string }; result: { path: string; base64: string } };
  files_put: { args: { path: string; base64: string }; result: { path: string } };
  /** A file the operator hands to a session (dropped, shared, picked): kept in the hub's uploads, its path returned for `@path`. */
  files_upload: { args: { name: string; base64: string }; result: { path: string } };
  /** Speech to text on the hub, with its user's OpenAI login (the app's voice input). */
  transcribe: { args: { base64: string; mime: string }; result: { text: string } };
  /** The hub's event log, newest last. */
  logs_tail: { args: { lines?: number }; result: { lines: string[] } };
  settings_get: { args: Record<string, never>; result: { settings: Record<string, unknown> } };
  /** `ifRevision`: the revision (settingRevision) of the value the change was made from; another one is a `conflict`. */
  settings_set: { args: { key: string; value: unknown; ifRevision?: string }; result: { settings: Record<string, unknown> } };
  /** A theme's colors as hex (pi's tokens plus pageBg and cardBg), for clients that draw it themselves. */
  theme_get: { args: { name?: string }; result: ThemeColors };
  /** Stops every agent and its processes and starts the hub again: in the same process when a client holds it, by its supervisor when it is a service. */
  hub_restart: { args: Record<string, never>; result: Record<string, never> };
  /**
   * Shows a session's terminal to this client: a shell in its directory, started at the first show
   * (and again after it exited); `screen` is its screen with history as ANSI, the stream follows as
   * terminal_output events.
   */
  terminal_open: { args: { session: string; cwd: string; cols: number; rows: number }; result: { screen: string } };
  terminal_input: { args: { session: string; data: string }; result: Record<string, never> };
  terminal_resize: { args: { session: string; cols: number; rows: number }; result: Record<string, never> };
  /** Hides it from this client: the shell runs on. */
  terminal_detach: { args: { session: string }; result: Record<string, never> };
};

/** A directory in dirs_list: `hasChildren` when it holds directories itself (it opens with →). */
export type DirItem = { name: string; path: string; hasChildren: boolean };

/** Who runs a hub: a client process (a TUI or web-app window holds it) or a service (`harness hub`). */
export type HubHost = "client" | "service";

/** A resolved theme: `appearance`, pi's color tokens and the page colors, all hex. */
export type ThemeColors = { name: string; appearance: "dark" | "light"; colors: Record<string, string>; names: string[] };

export type HubOp = keyof HubOps;

export const HUB_OPS: readonly HubOp[] = [
  "sessions_list",
  "session_read",
  "agents_list",
  "agent_start",
  "agent_attach",
  "agent_detach",
  "agent_close",
  "files_list",
  "dirs_list",
  "files_get",
  "files_put",
  "files_upload",
  "transcribe",
  "logs_tail",
  "settings_get",
  "settings_set",
  "theme_get",
  "hub_restart",
  "terminal_open",
  "terminal_input",
  "terminal_resize",
  "terminal_detach",
];

export type HubEvent =
  | { ev: "agents"; agents: AgentInfo[] }
  | { ev: "summary"; agent: string; summary: AgentSummary }
  | { ev: "agent_exited"; agent: string; code: number | null; error?: string }
  | { ev: "settings"; settings: Record<string, unknown> }
  /** Output of a session's terminal this client shows. */
  | { ev: "terminal_output"; session: string; data: string }
  /** Its shell exited; terminal_open starts another. */
  | { ev: "terminal_exit"; session: string; code: number };

/** What a client can draw besides the protocol's typed data: "component-bridge" — ANSI lines of an agent's pi-tui components (terminal clients). */
export type ClientCapability = "component-bridge";

export type ClientFrame =
  | { k: "hello"; protocol: number; client: string; token?: string; capabilities?: ClientCapability[] }
  | { k: "req"; id: string; op: HubOp; args: unknown }
  | { k: "hap"; agent: string; rec: HapRecord };

/** What carries a client's frames to a node: a unix socket, a WebSocket, an in-process node. */
export interface Transport {
  send(frame: ClientFrame): void;
  onFrame(listener: (frame: HubFrame) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

export type HubFrame =
  | { k: "welcome"; protocol: number; harness: string; hub: string; host: HubHost; pid: number }
  | { k: "refused"; error: ProtocolError }
  | { k: "res"; id: string; ok: true; data: unknown }
  | { k: "res"; id: string; ok: false; error: ProtocolError }
  | { k: "evt"; event: HubEvent }
  | { k: "hap"; agent: string; rec: HapRecord };
