// A harness hub: the agents of one OS user on one machine and the clients connected to them.
// Every endpoint (unix socket, WebSocket, in-process) hands its connections here; the hub speaks
// the hub protocol on them, runs agents as child processes, and fans each agent's HAP stream out
// to the connections attached to it — the whole stream ("full") or its summary ("summary").

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, toProtocolError } from "#protocol/errors.ts";
import type { AgentInfo, AttachLevel, ClientFrame, HubEvent, HubFrame, HubHost, HubOp, HubOps, HubStatus, NetworkSettings } from "#protocol/hub.ts";
import { HubAuth } from "./auth.ts";
import { HubNetwork, pairingLink, qrModules } from "./network.ts";
import { Workspace } from "./workspace.ts";
import { Attachments, ATTACHMENTS_RETENTION_DAYS, readSessionText } from "./attachments.ts";
import { HUB_OPS } from "#protocol/hub.ts";
import { settingRevision } from "#protocol/settings.ts";
import { listDirs } from "./dirs.ts";
import { SNAPSHOT_ENTRIES } from "#protocol/hap.ts";
import { themeColors } from "./themes.ts";
import { transcribe } from "./transcribe.ts";
import { MAX_SUBAGENT_DEPTH, type SubagentLaunch } from "#protocol/state.ts";
import { compatibleProtocol, PROTOCOL_VERSION } from "#protocol/version.ts";
import { AgentLink, type AgentRecord } from "./agent-link.ts";
import { listSessions, readSession, SessionLocks } from "./sessions.ts";
import { Terminals } from "./terminals.ts";
import { SettingsStore } from "./settings.ts";
import { checkClientFrame } from "#protocol/schemas.ts";
import { systemClock, type Clock } from "#protocol/clock.ts";
import { SummaryTracker } from "./summary.ts";
import { Telemetry } from "./telemetry.ts";

/**
 * One client connection, whatever carries it. The hub is its user's alone: whoever reached it (a
 * local endpoint, a paired device) is that user.
 */
export interface Connection {
  readonly id: string;
  /** The paired device on the other end of a network connection (for the log). */
  readonly device?: string;
  /** The agent on the other end, when an agent is the client (for its subagents). */
  readonly agent?: string;
  /** A client in the hub's own process (the window that holds it). */
  readonly inProcess?: boolean;
  send(frame: HubFrame): void;
  close(): void;
}

export type HubConfig = {
  name: string;
  /** The user's harness directory (~/.harness). */
  dataDir: string;
  harnessVersion: string;
  /** How to start an agent: an executable and its first arguments. */
  agentCommand?: string[];
  /** Extra environment of every agent (the test stand's scripted model). */
  agentEnv?: Record<string, string>;
  /** Summaries go out at most this often per agent. */
  summaryIntervalMs?: number;
  clock?: Clock;
  /** Unload agents idle this long (default IDLE_UNLOAD_MS). */
  idleUnloadMs?: number;
  /** At most this many agents (default MAX_AGENTS). */
  maxAgents?: number;
  /** Entries of an attach's snapshot; older ones load page by page (default SNAPSHOT_ENTRIES). */
  snapshotEntries?: number;
  /** Who runs the hub (welcome's `host`): a client window holding it, or a service (default). */
  host?: HubHost;
  /** hub_restart: stops the agents and starts the hub again (a holder in its process, a service by exiting). */
  restart?: () => Promise<void>;
  /** The network access the service's configuration sets (the user's `hub.network` setting otherwise). */
  network?: NetworkSettings;
};

type Attachment = { level: AttachLevel; live: boolean };

/** A subagent's start: its parent, its launch (with the depth the hub set), whether it outlives the parent. */
type ChildStart = { parent: AgentEntry; launch: SubagentLaunch; background: boolean };

type AgentEntry = {
  info: AgentInfo;
  link: AgentLink;
  summary: SummaryTracker;
  attachments: Map<Connection, Attachment>;
  /** Rewritten request id -> the connection and its own id. */
  requests: Map<string, { connection: Connection; id: unknown }>;
  summaryTimer?: unknown;
  summaryDue: boolean;
  lastSummaryAt: number;
  /** Clients following in full that draw bridged components, as last told to the agent. */
  componentClients: number;
  /** When the agent became idle (checked at `now`). */
  idleSince(now: number): number;
};

/** Idle agents are unloaded after this long; checks run this often; at most this many agents run. */
export const IDLE_UNLOAD_MS = 30 * 60_000;
const UNLOAD_CHECK_MS = 60_000;
/** How often attachments nothing names are looked for. */
const SWEEP_EVERY_MS = 24 * 3600 * 1000;
export const MAX_AGENTS = 32;

/** The agent of this checkout or bundle: node running packages/agent/src/main.ts. */
export function defaultAgentCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("../../agent/src/main.ts", import.meta.url))];
}

export class Hub {
  readonly config: HubConfig;
  private readonly agents = new Map<string, AgentEntry>();
  /** Each agent's own client connection to the hub (for its subagents), by agent id. */
  private readonly agentConnections = new Map<string, Connection>();
  private readonly agentReceivers = new Map<string, (frame: ClientFrame) => void>();
  private readonly connections = new Map<string, { connection: Connection; welcomed: boolean; capabilities: Set<string> }>();
  private readonly locks: SessionLocks;
  readonly settings: SettingsStore;
  private counter = 0;
  readonly clock: Clock;
  private unloadTimer: unknown;
  readonly telemetry: Telemetry;
  private readonly terminals: Terminals;
  private readonly auth: HubAuth;
  readonly network: HubNetwork;
  readonly workspace: Workspace;
  private readonly attachments: Attachments;
  private sweepTimer: unknown;
  private closing = false;

  constructor(config: HubConfig) {
    this.config = config;
    this.clock = config.clock ?? systemClock;
    this.telemetry = new Telemetry(config.dataDir, config.name, () => this.clock.now());
    // the sessions' terminals: their events to the connections that show them
    this.terminals = new Terminals(
      (viewer, event) => (viewer as Connection).send({ k: "evt", event }),
      (event) => this.telemetry.log(event),
    );
    this.scheduleUnload();
    this.locks = new SessionLocks(config.dataDir);
    this.settings = new SettingsStore(config.dataDir);
    this.auth = new HubAuth(config.dataDir);
    this.network = new HubNetwork(this, this.auth, config.network);
    this.settings.onChange((settings) => {
      this.broadcast({ ev: "settings", settings });
      void this.network.apply();
    });
    void this.network.apply();
    this.workspace = new Workspace(config.dataDir);
    this.workspace.onChange((workspace) => this.broadcast({ ev: "workspace", workspace }));
    this.attachments = new Attachments(config.dataDir);
    this.scheduleSweep(0);
  }

  /** Attachments nothing names any more go (at start, then daily). */
  private scheduleSweep(delay: number): void {
    this.sweepTimer = this.clock.setTimeout(() => {
      void this.sweepAttachments().finally(() => (this.closing ? undefined : this.scheduleSweep(SWEEP_EVERY_MS)));
    }, delay);
  }

  private async sweepAttachments(): Promise<void> {
    const days = this.settings.read()["attachments.retentionDays"];
    const drafts = this.workspace.read().tabs.flatMap((tab) => (tab.draft !== undefined ? [tab.draft.text] : []));
    const sessions = new Map((await listSessions(this.config.dataDir).catch(() => [])).map((session) => [session.id, session.path]));
    const removed = await this.attachments
      .sweep(typeof days === "number" && days > 0 ? days : ATTACHMENTS_RETENTION_DAYS, this.clock.now(), drafts, (session) => readSessionText(sessions.get(session)))
      .catch(() => []);
    if (removed.length > 0) {
      this.telemetry.log({ event: "attachments_removed", count: removed.length });
    } else {
      // nothing to remove
    }
  }

  /* ----- network access and devices ----- */

  status(): HubStatus {
    const connected = new Set([...this.connections.values()].flatMap(({ connection }) => (connection.device !== undefined ? [connection.device] : [])));
    return {
      network: { ...this.network.settings(), ...this.network.status() },
      devices: this.auth.devices().map((device) => ({ ...device, connected: connected.has(device.name) })),
      pairings: this.auth.pairings(this.clock.now()),
    };
  }

  /** Tells every client what the /hub dialog shows changed. */
  devicesChanged(): void {
    if (!this.closing) {
      this.broadcast({ ev: "hub", status: this.status() });
    } else {
      // closing: nobody to tell
    }
  }

  /** Revokes a device: its token is forgotten and its connections close at once. */
  revokeDevice(name: string): void {
    this.auth.revokeDevice(name);
    this.telemetry.log({ event: "device_revoked", device: name });
    for (const { connection } of [...this.connections.values()]) {
      if (connection.device === name) {
        connection.send({ k: "refused", error: { code: "unauthorized", message: "this device was revoked: pair it again" } });
        connection.close();
      } else {
        // another device, or a local client
      }
    }
    this.devicesChanged();
  }

  /**
   * Whether the hub may go to sleep (`hub.idleExit`): no client is connected and no agent works —
   * no run, no question waiting, no background task.
   */
  asleepAllowed(): boolean {
    const clients = [...this.connections.values()].filter(({ connection, welcomed }) => welcomed && connection.agent === undefined).length;
    return clients === 0 && this.activity().running === 0;
  }

  /* ----- connections ----- */

  accept(connection: Connection): (frame: ClientFrame) => void {
    this.connections.set(connection.id, { connection, welcomed: false, capabilities: new Set() });
    return (frame) => void this.receive(connection, frame);
  }

  /** Tells an agent how many clients following it in full can draw bridged components. */
  private reportClients(entry: AgentEntry): void {
    const count = [...entry.attachments].filter(([connection, attachment]) => attachment.level === "full" && (this.connections.get(connection.id)?.capabilities.has("component-bridge") ?? false)).length;
    if (count !== entry.componentClients) {
      entry.componentClients = count;
      entry.link.send({ type: "harness_clients", componentBridge: count });
    } else {
      // unchanged
    }
  }

  disconnect(connection: Connection): void {
    this.connections.delete(connection.id);
    this.terminals.disconnect(connection);
    this.telemetry.log({ event: "disconnect", connection: connection.id });
    for (const entry of this.agents.values()) {
      entry.attachments.delete(connection);
      this.reportClients(entry);
      for (const [key, request] of entry.requests) {
        if (request.connection === connection) {
          entry.requests.delete(key);
        } else {
          // another connection's request
        }
      }
    }
  }

  private async receive(connection: Connection, frame: ClientFrame): Promise<void> {
    const state = this.connections.get(connection.id);
    const checked = checkClientFrame(frame);
    if (state === undefined) {
      return; // closed meanwhile
    } else if (!checked.ok) {
      if (!state.welcomed) {
        connection.send({ k: "refused", error: { code: "invalid_record", message: checked.error } });
        connection.close();
      } else {
        this.refuse(connection, frame, { code: "invalid_record", message: checked.error });
      }
    } else if (!state.welcomed) {
      if (frame.k !== "hello") {
        connection.send({ k: "refused", error: { code: "invalid_record", message: "the first frame must be hello" } });
        connection.close();
      } else if (!compatibleProtocol(frame.protocol)) {
        this.telemetry.log({ event: "refused", connection: connection.id, code: "version_mismatch" });
        connection.send({ k: "refused", error: { code: "version_mismatch", message: `protocol ${frame.protocol} is not ${PROTOCOL_VERSION}: update the client or the hub` } });
        connection.close();
      } else {
        state.welcomed = true;
        state.capabilities = new Set(frame.capabilities ?? []);
        this.telemetry.log({ event: "connect", connection: connection.id, client: frame.client, ...(connection.device !== undefined ? { device: connection.device } : {}) });
        connection.send({ k: "welcome", protocol: PROTOCOL_VERSION, harness: this.config.harnessVersion, hub: this.config.name, host: this.config.host ?? "service", pid: process.pid });
      }
    } else {
      switch (frame.k) {
        case "hello":
          connection.send({ k: "res", id: "", ok: false, error: { code: "invalid_record", message: "hello was already exchanged" } });
          break;
        case "req":
          await this.request(connection, frame.id, frame.op, frame.args);
          break;
        case "hap":
          this.forward(connection, frame.agent, frame.rec as AgentRecord);
          break;
        default:
          connection.send({ k: "res", id: "", ok: false, error: { code: "invalid_record", message: `unknown frame ${String((frame satisfies never as { k: string }).k)}` } });
      }
    }
  }

  /** Answers a frame with an error: an operation's response, or the HAP response of an agent request. */
  refuse(connection: Connection, frame: ClientFrame, error: { code: "invalid_record"; message: string }): void {
    // the frame may be malformed: only what is there is echoed back
    const loose = frame as { k?: unknown; id?: unknown; agent?: unknown; rec?: { id?: unknown } };
    switch (loose.k) {
      case "req":
        connection.send({ k: "res", id: String(loose.id ?? ""), ok: false, error });
        break;
      case "hap":
        connection.send({ k: "hap", agent: String(loose.agent ?? ""), rec: { type: "harness_response", id: String(loose.rec?.id ?? ""), ok: false, error } });
        break;
      case "hello":
        connection.send({ k: "refused", error });
        break;
      default:
        break; // a frame of a newer protocol
    }
  }

  private async request(connection: Connection, id: string, op: HubOp, args: unknown): Promise<void> {
    if (!HUB_OPS.includes(op)) {
      connection.send({ k: "res", id, ok: false, error: { code: "invalid_record", message: `unknown operation ${String(op)}` } });
    } else {
      try {
        const data = await this.operate(connection, id, op, (args ?? {}) as never);
        if (data !== undefined) {
          connection.send({ k: "res", id, ok: true, data });
        } else {
          // answered later (agent_attach answers with the snapshot)
        }
      } catch (error) {
        connection.send({ k: "res", id, ok: false, error: toProtocolError(error) });
      }
    }
  }

  /** Runs one operation; undefined when the answer comes later under the same id (agent_attach). */
  private async operate<K extends HubOp>(connection: Connection, id: string, op: K, args: HubOps[K]["args"]): Promise<HubOps[K]["result"] | undefined> {
    switch (op) {
      case "sessions_list": {
        const { cwd } = args as HubOps["sessions_list"]["args"];
        const sessions = await listSessions(this.config.dataDir, cwd);
        const served = new Map([...this.agents.values()].map((entry) => [entry.info.sessionId, entry.info.id]));
        return { sessions: sessions.map((session) => ({ ...session, agent: served.get(session.id) })) } as HubOps[K]["result"];
      }
      case "session_read": {
        const { file, cursor, limit } = args as HubOps["session_read"]["args"];
        return readSession(this.config.dataDir, file, cursor, limit ?? SNAPSHOT_ENTRIES) as HubOps[K]["result"];
      }
      case "agents_list":
        return { agents: this.agentList() } as HubOps[K]["result"];
      case "agent_start": {
        const { cwd, sessionFile, subagent, background } = args as HubOps["agent_start"]["args"];
        const parent = connection.agent !== undefined ? this.agents.get(connection.agent) : undefined;
        if (subagent === undefined) {
          // a client on another machine may not know this hub's paths: "~" is the hub user's home
          return { agent: await this.startAgent(this.expandHome(cwd), sessionFile) } as HubOps[K]["result"];
        } else if (parent === undefined) {
          throw new HarnessError("forbidden", "only an agent starts subagents");
        } else {
          const depth = (parent.info.subagent?.depth ?? 0) + 1;
          if (depth > MAX_SUBAGENT_DEPTH) {
            throw new HarnessError("forbidden", `a subagent of depth ${depth - 1} cannot start subagents`);
          } else {
            const child = { parent, launch: { ...subagent, depth }, background: background === true };
            return { agent: await this.startAgent(this.expandHome(cwd), sessionFile, child) } as HubOps[K]["result"];
          }
        }
      }
      case "agent_attach": {
        const { agent, level } = args as HubOps["agent_attach"]["args"];
        return this.attach(connection, id, agent, level) as HubOps[K]["result"] | undefined;
      }
      case "agent_detach": {
        const { agent } = args as HubOps["agent_detach"]["args"];
        const entry = this.requireAgent(agent);
        entry.attachments.delete(connection);
        this.reportClients(entry);
        return {} as HubOps[K]["result"];
      }
      case "agent_close": {
        const { agent } = args as HubOps["agent_close"]["args"];
        await this.requireAgent(agent).link.stop();
        return {} as HubOps[K]["result"];
      }
      case "files_list": {
        const { path } = args as HubOps["files_list"]["args"];
        const dir = this.userPath(path);
        const entries = await readdir(dir, { withFileTypes: true });
        const items = await Promise.all(
          entries.map(async (entry) => {
            const full = join(dir, entry.name);
            const info = await stat(full).catch(() => undefined);
            return { name: entry.name, path: full, kind: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file", size: info?.size ?? 0 } as const;
          }),
        );
        return { path: dir, items } as HubOps[K]["result"];
      }
      case "dirs_list": {
        const { path, hidden } = args as HubOps["dirs_list"]["args"];
        const full = this.expandHome(path);
        try {
          return { ...(await listDirs(full, hidden === true)), home: homedir() } as HubOps[K]["result"];
        } catch (error) {
          throw new HarnessError("not_found", `${full}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      case "files_get": {
        const { path } = args as HubOps["files_get"]["args"];
        const full = this.userPath(path);
        return { path: full, base64: (await readFile(full)).toString("base64") } as HubOps[K]["result"];
      }
      case "files_put": {
        const { path, base64 } = args as HubOps["files_put"]["args"];
        const full = this.userPath(path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, Buffer.from(base64, "base64"));
        return { path: full } as HubOps[K]["result"];
      }
      case "attachments_put": {
        const { session, name, base64 } = args as HubOps["attachments_put"]["args"];
        return { path: await this.attachments.put(session, name, Buffer.from(base64, "base64")) } as HubOps[K]["result"];
      }
      case "workspace_get":
        return this.workspace.read() as HubOps[K]["result"];
      case "workspace_tabs_set": {
        const { tabs, ifRevision } = args as HubOps["workspace_tabs_set"]["args"];
        return this.workspace.setTabs(tabs, ifRevision) as HubOps[K]["result"];
      }
      case "workspace_draft_set": {
        const { tab, text, keep } = args as HubOps["workspace_draft_set"]["args"];
        return this.workspace.setDraft(tab, text, keep, this.clock.now()) as HubOps[K]["result"];
      }
      case "workspace_tab_replace": {
        const { sessionId, next } = args as HubOps["workspace_tab_replace"]["args"];
        return this.workspace.replaceSession(sessionId, next) as HubOps[K]["result"];
      }
      case "settings_get":
        return { settings: this.settings.read() } as HubOps[K]["result"];
      case "settings_set": {
        const { key, value, ifRevision } = args as HubOps["settings_set"]["args"];
        if (ifRevision !== undefined && settingRevision(this.settings.read()[key]) !== ifRevision) {
          throw new HarnessError("conflict", `${key} changed meanwhile: apply the change to its current value`);
        } else {
          return { settings: this.settings.set(key, value) } as HubOps[K]["result"];
        }
      }
      case "transcribe": {
        const { base64, mime } = args as HubOps["transcribe"]["args"];
        return { text: await transcribe(this.config.dataDir, Buffer.from(base64, "base64"), mime) } as HubOps[K]["result"];
      }
      case "logs_tail": {
        const { lines } = args as HubOps["logs_tail"]["args"];
        return { lines: this.telemetry.tail(lines ?? 200) } as HubOps[K]["result"];
      }
      case "theme_get": {
        const { name } = args as HubOps["theme_get"]["args"];
        const chosen = name ?? this.settings.read()["ui.theme"];
        return (await themeColors(this.config.dataDir, typeof chosen === "string" ? chosen : undefined)) as HubOps[K]["result"];
      }
      case "hub_restart": {
        const restart = this.config.restart;
        if (restart === undefined) {
          throw new HarnessError("invalid_record", `${this.config.name} cannot restart itself`);
        } else {
          this.telemetry.log({ event: "hub_restart", connection: connection.id });
          // after the answer: the restart closes this connection too
          setImmediate(() => void restart());
          return {} as HubOps[K]["result"];
        }
      }
      case "terminal_open": {
        const { session, cwd, cols, rows } = args as HubOps["terminal_open"]["args"];
        return (await this.terminals.open(connection, session, this.expandHome(cwd), cols, rows)) as HubOps[K]["result"];
      }
      case "editor_open": {
        const { session, cwd, text, cols, rows } = args as HubOps["editor_open"]["args"];
        return (await this.openEditor(connection, session, this.expandHome(cwd), text, cols, rows)) as HubOps[K]["result"];
      }
      case "terminal_input": {
        const { session, data } = args as HubOps["terminal_input"]["args"];
        this.terminals.input(session, data);
        return {} as HubOps[K]["result"];
      }
      case "terminal_resize": {
        const { session, cols, rows } = args as HubOps["terminal_resize"]["args"];
        this.terminals.resize(session, cols, rows);
        return {} as HubOps[K]["result"];
      }
      case "terminal_detach": {
        const { session } = args as HubOps["terminal_detach"]["args"];
        this.terminals.detach(connection, session);
        return {} as HubOps[K]["result"];
      }
      case "hub_status":
        return this.status() as HubOps[K]["result"];
      case "hub_network_set": {
        const change = args as HubOps["hub_network_set"]["args"];
        if (this.network.settings().source === "service") {
          throw new HarnessError("forbidden", "the service's configuration sets the network access: change it there");
        } else {
          const { source: _source, ...current } = this.network.settings();
          this.settings.set("hub.network", { ...current, ...change });
          await this.network.apply();
          return this.status() as HubOps[K]["result"];
        }
      }
      case "device_pair": {
        const { name } = args as HubOps["device_pair"]["args"];
        const pairing = this.auth.addPairing(name, this.clock.now());
        const url = this.network.settings().url;
        this.telemetry.log({ event: "pairing_created", pairing: pairing.id, ...(name !== undefined ? { name } : {}) });
        this.devicesChanged();
        if (url !== undefined) {
          const link = pairingLink(url, pairing.code);
          return { ...pairing, link, qr: await qrModules(link) } as HubOps[K]["result"];
        } else {
          return pairing as HubOps[K]["result"];
        }
      }
      case "device_rename": {
        const { name, to } = args as HubOps["device_rename"]["args"];
        this.auth.renameDevice(name, to);
        this.telemetry.log({ event: "device_renamed", device: name, to });
        this.devicesChanged();
        return this.status() as HubOps[K]["result"];
      }
      case "device_revoke": {
        const { name } = args as HubOps["device_revoke"]["args"];
        this.revokeDevice(name);
        return this.status() as HubOps[K]["result"];
      }
      default:
        throw new HarnessError("invalid_record", `unknown operation ${String(op satisfies never)}`);
    }
  }

  /**
   * A session's draft in the prompt editor: the draft goes into a file among the session's
   * attachments, `$HARNESS_EDITOR` (or the bundle's micro) runs on it in the terminal
   * `prompt:<session>`; when it exits, the file's text is the draft — kept in the workspace when the
   * session is there, and to every client (editor_closed) — and the file goes. Open already: its
   * screen, nothing starts again.
   */
  private async openEditor(connection: Connection, session: string, cwd: string, text: string, cols: number, rows: number): Promise<{ screen: string }> {
    const command = process.env.HARNESS_EDITOR ?? process.env.HARNESS_BUNDLED_EDITOR ?? "micro";
    const file = join(this.attachments.dir, session.replace(/[^A-Za-z0-9_.-]/g, "_"), `prompt-${randomUUID()}.md`);
    if (this.terminals.editing(session)) {
      return this.terminals.openEditor(connection, session, cwd, cols, rows, command, file, () => undefined);
    } else {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, { mode: 0o600 });
      this.telemetry.log({ event: "prompt_editor_opened", session, command });
      return this.terminals.openEditor(connection, session, cwd, cols, rows, command, file, (code) => {
        void readFile(file, "utf8")
          .catch(() => text)
          .then(async (written) => {
            // an editor saves with a final newline: the draft has none
            const draft = written.replace(/\n$/, "");
            const tab = this.workspace.read().tabs.find((candidate) => candidate.sessionId === session);
            if (tab !== undefined) {
              this.workspace.setDraft(tab, draft, true, this.clock.now());
            } else {
              // a window's own session: its client keeps the draft (editor_closed)
            }
            this.telemetry.log({ event: "prompt_editor_closed", session, code });
            this.broadcast({ ev: "editor_closed", session, text: draft });
            await rm(file, { force: true });
          });
      });
    }
  }

  /** Paths of the files operations: inside the home directory of the hub's user. */
  /** "~" and "~/…" are the hub user's home; a relative path is relative to it. */
  private expandHome(path: string): string {
    const home = homedir();
    return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(home, path);
  }

  /** A path of the hub user's files: their home, or the temporary directory (where agents put files they send). */
  private userPath(path: string): string {
    const full = this.expandHome(path);
    const within = (root: string): boolean => full === root || full.startsWith(`${root}/`);
    if (within(homedir()) || within(tmpdir())) {
      return full;
    } else {
      throw new HarnessError("forbidden", `${path} is outside ${homedir()} and ${tmpdir()}`);
    }
  }

  /* ----- agents ----- */

  private agentList(): AgentInfo[] {
    return [...this.agents.values()].map((entry) => ({ ...entry.info, summary: entry.summary.current }));
  }

  private requireAgent(id: string): AgentEntry {
    const entry = this.agents.get(id);
    if (entry === undefined) {
      throw new HarnessError("not_found", `no agent ${id} on hub ${this.config.name}`);
    } else {
      return entry;
    }
  }

  /** Whether an agent may be unloaded: nobody follows it in full, no run, no open interaction, no live task. */
  private idle(entry: AgentEntry): boolean {
    const summary = entry.summary.current;
    const followed = [...entry.attachments.values()].some((attachment) => attachment.level === "full");
    return !followed && summary.status === "idle" && summary.waiting === 0 && summary.tasks.running === 0;
  }

  /** Unloads agents idle for longer than idleUnloadMs (their sessions stay; opening one starts an agent again). */
  private async unloadIdle(): Promise<void> {
    const limit = this.config.idleUnloadMs ?? IDLE_UNLOAD_MS;
    const now = this.clock.now();
    for (const entry of [...this.agents.values()]) {
      if (this.idle(entry) && now - entry.idleSince(now) >= limit) {
        this.telemetry.log({ event: "agent_unload", agent: entry.info.id });
        await entry.link.stop();
      } else {
        // busy, followed, or not idle long enough
      }
    }
  }

  private scheduleUnload(): void {
    this.unloadTimer = this.clock.setTimeout(() => {
      void this.unloadIdle().finally(() => (this.closing ? undefined : this.scheduleUnload()));
    }, UNLOAD_CHECK_MS);
  }

  /**
   * The agent of a session: the one serving it, the one starting for it (two clients opening the
   * same session at once get one agent), or a new one.
   */
  async startAgent(cwd: string, sessionFile?: string, child?: ChildStart): Promise<AgentInfo> {
    if (sessionFile === undefined) {
      return this.launchAgent(cwd, sessionFile, child);
    } else {
      const pending = this.starting.get(sessionFile);
      if (pending !== undefined) {
        return pending;
      } else {
        const start = this.launchAgent(cwd, sessionFile, child).finally(() => this.starting.delete(sessionFile));
        this.starting.set(sessionFile, start);
        return start;
      }
    }
  }

  private async launchAgent(cwd: string, sessionFile?: string, child?: ChildStart): Promise<AgentInfo> {
    const served = sessionFile !== undefined ? [...this.agents.values()].find((entry) => entry.info.sessionFile === sessionFile) : undefined;
    const max = this.config.maxAgents ?? MAX_AGENTS;
    if (served !== undefined) {
      return { ...served.info, summary: served.summary.current };
    } else if (sessionFile !== undefined && !existsSync(sessionFile)) {
      // pi would start another session (another id) in its place: the tab asking for it would wait forever
      throw new HarnessError("not_found", `no session file ${sessionFile}: the session has no message yet, or it was removed`);
    } else if (this.agents.size >= max) {
      // the oldest idle agent makes room; with none idle the start is refused
      const oldest = [...this.agents.values()].filter((entry) => this.idle(entry)).sort((a, b) => a.idleSince(this.clock.now()) - b.idleSince(this.clock.now()))[0];
      if (oldest === undefined) {
        throw new HarnessError("agent_failed", `${max} agents run on hub ${this.config.name} and none is idle: close a session first`);
      } else {
        await oldest.link.stop();
        return this.launchAgent(cwd, sessionFile, child);
      }
    } else {
      this.counter += 1;
      const id = `a${this.counter}-${randomUUID().slice(0, 4)}`;
      const link = new AgentLink({
        command: this.config.agentCommand ?? defaultAgentCommand(),
        cwd,
        sessionFile,
        parentSession: child?.parent.info.sessionFile,
        subagent: child?.launch,
        env: { ...process.env, HARNESS_HOME: this.config.dataDir, ...this.config.agentEnv },
        logPath: join(this.config.dataDir, "log", "agents", `${id}.log`),
      });
      const summary = new SummaryTracker(this.clock.now());
      // records after hello and before the agent is registered are kept and replayed then
      const early: AgentRecord[] = [];
      let helloSeen = false;
      const offEarly = link.onRecord((record) => {
        if (helloSeen) {
          early.push(record);
        } else {
          // hello itself is read below; nothing comes before it
        }
      });
      const hello = await new Promise<AgentRecord>((resolveHello, reject) => {
        const off = link.onRecord((record) => {
          if (record.type === "harness_hello") {
            off();
            helloSeen = true;
            resolveHello(record);
          } else {
            // records before hello: none are expected
          }
        });
        link.onExit((code, error) => reject(new HarnessError("agent_failed", `the agent exited before it started (${error ?? `exit ${code}`}); its log: ${join(this.config.dataDir, "log", "agents", `${id}.log`)}`)));
      });
      const session = hello.session as { sessionId: string; sessionFile?: string; sessionName?: string; cwd: string };
      try {
        this.locks.acquire(session.sessionId);
      } catch (error) {
        await link.stop();
        throw error;
      }
      summary.apply(hello, this.clock.now());
      const entry: AgentEntry = {
        info: {
          id,
          hub: this.config.name,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          cwd: session.cwd,
          name: session.sessionName,
          parent: child?.parent.info.id,
          subagent: child !== undefined ? { profile: child.launch.profile, background: child.background, depth: child.launch.depth } : undefined,
          startedAt: this.clock.now(),
          summary: summary.current,
        },
        link,
        summary,
        attachments: new Map(),
        componentClients: 0,
        idleSince: (() => {
          // when the agent last became idle (by the clock): busy agents are "idle since now"
          let since = this.clock.now();
          return (now: number): number => {
            if (!this.idle(entry)) {
              since = now;
            } else {
              // idle since then
            }
            return since;
          };
        })(),
        requests: new Map(),
        summaryDue: false,
        lastSummaryAt: 0,
      };
      this.agents.set(id, entry);
      offEarly();
      link.onRecord((record) => this.fromAgent(entry, record));
      for (const record of early.splice(0)) {
        this.fromAgent(entry, record);
      }
      link.onExit((code, error) => {
        this.agents.delete(id);
        this.locks.release(entry.info.sessionId);
        this.agentConnections.get(id)?.close();
        // a closed parent takes its subagents with it, except background ones: they finish and report
        for (const other of [...this.agents.values()]) {
          if (other.info.parent === id && other.info.subagent?.background !== true) {
            void other.link.stop();
          } else {
            // not its child, or a background one
          }
        }
        if (entry.summaryTimer !== undefined) {
          this.clock.clearTimeout(entry.summaryTimer);
        } else {
          // no summary pending
        }
        this.telemetry.log({ event: "agent_exit", agent: id, code, error });
        this.broadcast({ ev: "agent_exited", agent: id, code, error });
        this.broadcast({ ev: "agents", agents: this.agentList() });
      });
      this.telemetry.log({ event: "agent_start", agent: id, session: entry.info.sessionId, cwd: entry.info.cwd });
      this.broadcast({ ev: "agents", agents: this.agentList() });
      return { ...entry.info, summary: summary.current };
    }
  }

  private attach(connection: Connection, id: string, agentId: string, level: AttachLevel): { agent: AgentInfo; snapshot?: unknown } | undefined {
    const entry = this.requireAgent(agentId);
    if (level === "summary") {
      entry.attachments.set(connection, { level, live: true });
      this.reportClients(entry);
      return { agent: { ...entry.info, summary: entry.summary.current } };
    } else {
      // full: the snapshot answers the attach; events after it go to the connection
      entry.attachments.set(connection, { level: "full", live: false });
      this.reportClients(entry);
      const key = `attach.${connection.id}.${id}`;
      entry.requests.set(key, { connection, id: `attach:${id}` });
      entry.link.send({ type: "harness_snapshot", id: key, limit: this.config.snapshotEntries ?? SNAPSHOT_ENTRIES });
      return undefined;
    }
  }

  /** A record a client sends to an agent: its id is rewritten so the answer finds its way back. */
  private forward(connection: Connection, agentId: string, record: AgentRecord): void {
    const entry = this.agents.get(agentId);
    if (entry === undefined) {
      connection.send({ k: "hap", agent: agentId, rec: { type: "harness_response", id: String(record.id ?? ""), ok: false, error: { code: "not_found", message: `no agent ${agentId}` } } });
    } else {
      if (record.type === "harness_prompt" || record.type === "prompt") {
        entry.summary.titleFrom(String(record.text ?? record.message ?? ""));
      } else {
        // not a prompt
      }
      if (record.id !== undefined) {
        const key = `${connection.id}.${String(record.id)}`;
        entry.requests.set(key, { connection, id: record.id });
        entry.link.send({ ...record, id: key });
      } else {
        entry.link.send(record);
      }
    }
  }

  /** An agent's own client connection to this hub (for its subagents), made on its first frame. */
  private agentConnection(entry: AgentEntry): (frame: ClientFrame) => void {
    const existing = this.agentReceivers.get(entry.info.id);
    if (existing !== undefined) {
      return existing;
    } else {
      let open = true;
      const connection: Connection = {
        id: `agent.${entry.info.id}`,
        agent: entry.info.id,
        send: (frame) => {
          if (open) {
            entry.link.send({ type: "harness_hub", frame });
          } else {
            // the agent is gone
          }
        },
        close: () => {
          if (open) {
            open = false;
            this.agentReceivers.delete(entry.info.id);
            this.agentConnections.delete(entry.info.id);
            this.disconnect(connection);
          } else {
            // closed already
          }
        },
      };
      const receive = this.accept(connection);
      this.agentReceivers.set(entry.info.id, receive);
      this.agentConnections.set(entry.info.id, connection);
      return receive;
    }
  }

  private fromAgent(entry: AgentEntry, record: AgentRecord): void {
    if (record.type === "harness_hub") {
      this.agentConnection(entry)(record.frame as ClientFrame);
      return;
    } else {
      // a record of the agent's own stream
    }
    const isResponse = record.type === "harness_response" || record.type === "response";
    const routed = isResponse && typeof record.id === "string" ? entry.requests.get(record.id) : undefined;
    if (routed !== undefined && typeof record.id === "string") {
      entry.requests.delete(record.id);
      const original = String(routed.id);
      if (original.startsWith("attach:")) {
        const attachment = entry.attachments.get(routed.connection);
        if (attachment !== undefined) {
          attachment.live = true;
        } else {
          // detached before the snapshot came
        }
        if (record.ok === true) {
          routed.connection.send({ k: "res", id: original.slice("attach:".length), ok: true, data: { agent: { ...entry.info, summary: entry.summary.current }, snapshot: record.data } });
        } else {
          routed.connection.send({ k: "res", id: original.slice("attach:".length), ok: false, error: (record.error as never) ?? { code: "agent_failed", message: "no snapshot" } });
        }
      } else {
        routed.connection.send({ k: "hap", agent: entry.info.id, rec: { ...record, id: routed.id } as never });
      }
    } else {
      if (record.type === "harness_session") {
        const session = record.session as { sessionId: string; sessionFile?: string; sessionName?: string };
        if (session.sessionId !== entry.info.sessionId) {
          this.locks.release(entry.info.sessionId);
          this.locks.acquire(session.sessionId);
        } else {
          // same session
        }
        entry.info = { ...entry.info, sessionId: session.sessionId, sessionFile: session.sessionFile, name: session.sessionName };
      } else {
        // not a session change
      }
      for (const [connection, attachment] of entry.attachments) {
        if (attachment.level === "full" && attachment.live) {
          connection.send({ k: "hap", agent: entry.info.id, rec: record as never });
        } else {
          // summary level, or waiting for its snapshot
        }
      }
      if (entry.summary.apply(record, this.clock.now())) {
        this.scheduleSummary(entry);
      } else {
        // the summary did not change
      }
    }
  }

  /** At most one summary per interval per agent; the last change always goes out. */
  private scheduleSummary(entry: AgentEntry): void {
    const interval = this.config.summaryIntervalMs ?? 250;
    const wait = entry.lastSummaryAt + interval - this.clock.now();
    if (entry.summaryTimer !== undefined) {
      entry.summaryDue = true;
    } else if (wait <= 0) {
      this.sendSummary(entry);
    } else {
      entry.summaryTimer = this.clock.setTimeout(() => {
        entry.summaryTimer = undefined;
        this.sendSummary(entry);
      }, wait);
    }
  }

  private sendSummary(entry: AgentEntry): void {
    entry.lastSummaryAt = this.clock.now();
    entry.summaryDue = false;
    this.broadcast({ ev: "summary", agent: entry.info.id, summary: entry.summary.current });
  }

  /** Events go to every connection through the handshake. */
  private broadcast(event: HubEvent): void {
    for (const { connection, welcomed } of this.connections.values()) {
      if (welcomed) {
        connection.send({ k: "evt", event });
      } else {
        // not through the handshake yet
      }
    }
  }

  /** Starts in progress, by session file. */
  private readonly starting = new Map<string, Promise<AgentInfo>>();

  /** What closing the hub would stop: its working agents, and the clients of other processes (windows) on it. */
  activity(): { running: number; otherClients: number } {
    const running = [...this.agents.values()].filter((entry) => entry.summary.current.status === "running" || entry.summary.current.status === "waiting" || entry.summary.current.tasks.running > 0).length;
    const otherClients = [...this.connections.values()].filter(({ connection, welcomed }) => welcomed && connection.inProcess !== true && connection.agent === undefined).length;
    return { running, otherClients };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.telemetry.log({ event: "hub_stop" });
    this.clock.clearTimeout(this.unloadTimer);
    this.clock.clearTimeout(this.sweepTimer);
    await this.network.close();
    await Promise.all([...this.agents.values()].map((entry) => entry.link.stop()));
    this.terminals.closeAll();
    this.locks.releaseAll();
    for (const { connection } of this.connections.values()) {
      connection.close();
    }
  }
}
