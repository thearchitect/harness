// The hub protocol: a client (TUI, app, test driver) and a hub over one connection — a unix
// socket, a WebSocket, or in-process. Frames are JSONL objects keyed by `k`. Control requests carry
// an id and get one response; HAP records of attached agents travel in `hap` frames addressed by
// agent id.

import type { ProtocolError } from "./errors.ts";
import type { HapRecord, SnapshotData } from "./hap.ts";
import type { LogRecord } from "./log.ts";
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
  /**
   * A file the operator hands to a session (pasted, dropped, shared, picked): kept with the
   * session's attachments by its content, its path returned for `@path` in the draft.
   */
  attachments_put: { args: { session: string; name: string; base64: string }; result: { path: string } };
  /** The user's workspace on this hub: its tabs and their drafts. */
  workspace_get: { args: Record<string, never>; result: WorkspaceData };
  /** The tabs as arranged (order, seen, closed ones gone), on the revision they were read at. */
  workspace_tabs_set: { args: { tabs: WorkspaceTab[]; ifRevision: number }; result: WorkspaceData };
  /** A session's draft (the last write wins); with it the session joins the tabs, or leaves them (see Workspace). */
  workspace_draft_set: { args: { tab: { sessionId: string; sessionFile: string; cwd: string }; text: string; keep: boolean }; result: WorkspaceData };
  /** A tab's session started anew in its place (its file was never written): the tab and its draft go with the new one. */
  workspace_tab_replace: { args: { sessionId: string; next: { sessionId: string; sessionFile: string } }; result: WorkspaceData };
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
  /** A client's log records (protocol/log.ts), kept with the hub's under their source (tui, app). */
  logs_put: { args: { records: LogRecord[] }; result: Record<string, never> };
  /**
   * Writes a session's draft in an editor in a terminal `prompt:<session>` (the terminal_* operations
   * and events as a session's terminal); open already, it shows as it is. Its exit brings
   * editor_closed with the file's text.
   */
  editor_open: { args: { session: string; cwd: string; text: string; cols: number; rows: number }; result: { screen: string } };
  /** The hub's network access and paired devices (the /hub dialog). */
  hub_status: { args: Record<string, never>; result: HubStatus };
  /** Changes the network access (kept in the user's settings, `hub.network`); refused when the service's configuration sets it. */
  hub_network_set: { args: Partial<NetworkSettings>; result: HubStatus };
  /**
   * A one-time code for a new device (`name`: its name, else the one it gives); `link` when the hub
   * knows its address, and its QR code: `size`×`size` modules, row by row, "1" dark.
   */
  device_pair: { args: { name?: string }; result: { id: string; code: string; expires: number; link?: string; qr?: { size: number; modules: string } } };
  device_rename: { args: { name: string; to: string }; result: HubStatus };
  /** Revokes a device: its connections close at once. */
  device_revoke: { args: { name: string }; result: HubStatus };
};

/**
 * The hub's network access: `listen` host:port of its HTTP endpoint (the app, /ws, /pair; TLS by a
 * proxy in front); an address off loopback needs `proxy` (only the proxy reaches the port);
 * `url`: the address devices use (pairing links).
 */
export type NetworkSettings = { enabled: boolean; listen: string; proxy: boolean; url?: string };

export type DeviceInfo = { name: string; created: number; lastSeen?: number; address?: string };

/** A tab of the workspace: its session, what of it was seen (ms), the message being written there. */
export type WorkspaceTab = { sessionId: string; sessionFile: string; cwd: string; seen?: number; draft?: { text: string; at: number } };

export type WorkspaceData = { revision: number; tabs: WorkspaceTab[] };

/** A pairing code made in the last PAIRING_TTL_MS: open, or `used` by the device it paired. */
export type PairingInfo = { id: string; expires: number; name?: string; used?: string };

export type HubStatus = {
  network: NetworkSettings & {
    /** Where the settings come from: the user's (the /hub dialog) or the service's configuration (read-only). */
    source: "settings" | "service";
    running: boolean;
    /** Why it does not run while enabled. */
    problem?: string;
  };
  devices: (DeviceInfo & { connected: boolean })[];
  pairings: PairingInfo[];
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
  "attachments_put",
  "workspace_get",
  "workspace_tabs_set",
  "workspace_draft_set",
  "workspace_tab_replace",
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
  "editor_open",
  "logs_put",
  "hub_status",
  "hub_network_set",
  "device_pair",
  "device_rename",
  "device_revoke",
];

export type HubEvent =
  | { ev: "agents"; agents: AgentInfo[] }
  | { ev: "summary"; agent: string; summary: AgentSummary }
  | { ev: "agent_exited"; agent: string; code: number | null; error?: string }
  | { ev: "settings"; settings: Record<string, unknown> }
  /** Output of a session's terminal this client shows. */
  | { ev: "terminal_output"; session: string; data: string }
  /** Its shell exited; terminal_open starts another. */
  | { ev: "terminal_exit"; session: string; code: number }
  /** A session's prompt editor exited: the file's text is its draft now. */
  | { ev: "editor_closed"; session: string; text: string }
  /** The network access or the devices changed (one paired, connected, was revoked). */
  | { ev: "hub"; status: HubStatus }
  /** The workspace changed: a tab opened, moved, closed, seen; a draft written. */
  | { ev: "workspace"; workspace: WorkspaceData };

/** What a client can draw besides the protocol's typed data: "component-bridge" — ANSI lines of an agent's pi-tui components (terminal clients). */
export type ClientCapability = "component-bridge";

export type ClientFrame =
  | { k: "hello"; protocol: number; client: string; token?: string; capabilities?: ClientCapability[] }
  | { k: "req"; id: string; op: HubOp; args: unknown }
  | { k: "hap"; agent: string; rec: HapRecord };

/** What carries a client's frames to a hub: a unix socket, SSH, a WebSocket, an in-process hub. */
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
