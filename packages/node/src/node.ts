// A harness node: the agents of one OS user on one machine and the clients connected to them.
// Every endpoint (unix socket, WebSocket, in-process) hands its connections here; the node speaks
// the node protocol on them, runs agents as child processes, and fans each agent's HAP stream out
// to the connections attached to it — the whole stream ("full") or its summary ("summary").

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, toProtocolError } from "#protocol/errors.ts";
import type { AgentInfo, AttachLevel, ClientFrame, NodeEvent, NodeFrame, NodeInfo, NodeOp, NodeOps } from "#protocol/node.ts";
import { NODE_OPS } from "#protocol/node.ts";
import { themeColors } from "./themes.ts";
import { MAX_SUBAGENT_DEPTH, type SubagentLaunch } from "#protocol/state.ts";
import { compatibleProtocol, PROTOCOL_VERSION } from "#protocol/version.ts";
import { AgentLink, type AgentRecord } from "./agent-link.ts";
import { listSessions, SessionLocks } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { checkClientFrame } from "#protocol/schemas.ts";
import { systemClock, type Clock } from "#protocol/clock.ts";
import { SummaryTracker } from "./summary.ts";
import { Telemetry } from "./telemetry.ts";

/** One client connection, whatever carries it. */
export interface Connection {
  readonly id: string;
  /** Who is on the other end: the node's own OS user (trusted), or a hub user. */
  readonly user: string;
  /** The node's own user through a local endpoint (unix socket, in-process): no access check. */
  readonly trusted: boolean;
  /** The agent on the other end, when an agent is the client (for its subagents). */
  readonly agent?: string;
  send(frame: NodeFrame): void;
  close(): void;
}

/** What a hub adds to its node: other nodes behind it, its users and their settings. */
export interface HubRole {
  /** A frame for another node: routed to it, or answered with an error. */
  route(connection: Connection, frame: ClientFrame & { node?: string }): void;
  nodes(user: string): NodeInfo[];
  /** Whether a hub user may use the hub's own node. */
  mayUseLocal(user: string): boolean;
  settingsFor(user: string): SettingsStore;
  disconnect(connection: Connection): void;
}

export type NodeConfig = {
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
  /** Hub users allowed on this node through its hubs (the node checks again what the hub checked). */
  users?: string[];
  clock?: Clock;
  /** Unload agents idle this long (default IDLE_UNLOAD_MS). */
  idleUnloadMs?: number;
  /** At most this many agents (default MAX_AGENTS). */
  maxAgents?: number;
};

type Attachment = { level: AttachLevel; live: boolean };

/** A subagent's start: its parent, its launch (with the depth the node set), whether it outlives the parent. */
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
export const MAX_AGENTS = 32;

/** The agent of this checkout or bundle: node running packages/agent/src/main.ts. */
export function defaultAgentCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("../../agent/src/main.ts", import.meta.url))];
}

export class HarnessNode {
  readonly config: NodeConfig;
  private readonly agents = new Map<string, AgentEntry>();
  /** Each agent's own client connection to the node (for its subagents), by agent id. */
  private readonly agentConnections = new Map<string, Connection>();
  private readonly agentReceivers = new Map<string, (frame: ClientFrame) => void>();
  private readonly connections = new Map<string, { connection: Connection; welcomed: boolean; capabilities: Set<string> }>();
  private readonly locks: SessionLocks;
  readonly settings: SettingsStore;
  private counter = 0;
  hub: HubRole | undefined;
  readonly clock: Clock;
  private unloadTimer: unknown;
  readonly telemetry: Telemetry;
  private closing = false;

  constructor(config: NodeConfig) {
    this.config = config;
    this.clock = config.clock ?? systemClock;
    this.telemetry = new Telemetry(config.dataDir, config.name, () => this.clock.now());
    this.scheduleUnload();
    this.locks = new SessionLocks(config.dataDir);
    this.settings = new SettingsStore(config.dataDir);
    this.settings.onChange((settings) => this.settingsChanged(this.settings, settings));
  }

  /** The settings a connection's user keeps here: a hub user's own, or the node user's. */
  settingsOf(connection: Connection): SettingsStore {
    return this.hub !== undefined && !connection.trusted ? this.hub.settingsFor(connection.user) : this.settings;
  }

  settingsChanged(store: SettingsStore, settings: Record<string, unknown>): void {
    for (const { connection, welcomed } of this.connections.values()) {
      if (welcomed && this.settingsOf(connection) === store) {
        connection.send({ k: "evt", node: this.config.name, event: { ev: "settings", settings } });
      } else {
        // another user's settings, or not through the handshake yet
      }
    }
  }

  /** Whether a connection may use this node's agents, sessions and files. */
  private allowed(connection: Connection): boolean {
    return connection.trusted || (this.config.users ?? []).includes(connection.user) || (this.hub?.mayUseLocal(connection.user) ?? false);
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
    this.telemetry.log({ event: "disconnect", connection: connection.id });
    this.hub?.disconnect(connection);
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
        connection.send({ k: "refused", error: { code: "version_mismatch", message: `protocol ${frame.protocol} is not ${PROTOCOL_VERSION}: update the client or the node` } });
        connection.close();
      } else {
        state.welcomed = true;
        state.capabilities = new Set(frame.capabilities ?? []);
        this.telemetry.log({ event: "connect", connection: connection.id, client: frame.client, user: connection.user, trusted: connection.trusted });
        connection.send({ k: "welcome", protocol: PROTOCOL_VERSION, harness: this.config.harnessVersion, node: this.config.name, user: connection.user });
      }
    } else if (frame.k !== "hello" && frame.node !== undefined && frame.node !== this.config.name) {
      if (this.hub !== undefined) {
        this.hub.route(connection, frame);
      } else {
        this.refuse(connection, frame, { code: "not_found", message: `no node ${frame.node} here: ${this.config.name} is not a hub` });
      }
    } else if (frame.k !== "hello" && !(frame.k === "req" && (frame.op === "nodes_list" || frame.op === "settings_get" || frame.op === "settings_set" || frame.op === "theme_get")) && !this.allowed(connection)) {
      this.refuse(connection, frame, { code: "forbidden", message: `${connection.user} may not use node ${this.config.name}` });
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
  refuse(connection: Connection, frame: ClientFrame, error: { code: "not_found" | "forbidden" | "node_offline" | "unauthorized" | "invalid_record"; message: string }): void {
    // the frame may be malformed: only what is there is echoed back
    const loose = frame as { k?: unknown; id?: unknown; node?: unknown; agent?: unknown; rec?: { id?: unknown } };
    switch (loose.k) {
      case "req":
        connection.send({ k: "res", id: String(loose.id ?? ""), ok: false, error });
        break;
      case "hap":
        connection.send({ k: "hap", node: typeof loose.node === "string" ? loose.node : this.config.name, agent: String(loose.agent ?? ""), rec: { type: "harness_response", id: String(loose.rec?.id ?? ""), ok: false, error } });
        break;
      case "hello":
        connection.send({ k: "refused", error });
        break;
      default:
        break; // a frame of a newer protocol
    }
  }

  private async request(connection: Connection, id: string, op: NodeOp, args: unknown): Promise<void> {
    if (!NODE_OPS.includes(op)) {
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
  private async operate<K extends NodeOp>(connection: Connection, id: string, op: K, args: NodeOps[K]["args"]): Promise<NodeOps[K]["result"] | undefined> {
    switch (op) {
      case "nodes_list": {
        const own = this.allowed(connection) ? [{ name: this.config.name, online: true, roles: this.hub !== undefined ? ["node", "hub"] : ["node"] }] : [];
        return { nodes: [...own, ...(this.hub?.nodes(connection.user) ?? [])] } as NodeOps[K]["result"];
      }
      case "sessions_list": {
        const { cwd } = args as NodeOps["sessions_list"]["args"];
        const sessions = await listSessions(this.config.dataDir, cwd);
        const served = new Map([...this.agents.values()].map((entry) => [entry.info.sessionId, entry.info.id]));
        return { sessions: sessions.map((session) => ({ ...session, agent: served.get(session.id) })) } as NodeOps[K]["result"];
      }
      case "agents_list":
        return { agents: this.agentList() } as NodeOps[K]["result"];
      case "agent_start": {
        const { cwd, sessionFile, subagent, background } = args as NodeOps["agent_start"]["args"];
        const parent = connection.agent !== undefined ? this.agents.get(connection.agent) : undefined;
        if (subagent === undefined) {
          // a client on another machine may not know this node's paths: "~" is the node user's home
          return { agent: await this.startAgent(this.expandHome(cwd), sessionFile) } as NodeOps[K]["result"];
        } else if (parent === undefined) {
          throw new HarnessError("forbidden", "only an agent starts subagents");
        } else {
          const depth = (parent.info.subagent?.depth ?? 0) + 1;
          if (depth > MAX_SUBAGENT_DEPTH) {
            throw new HarnessError("forbidden", `a subagent of depth ${depth - 1} cannot start subagents`);
          } else {
            const child = { parent, launch: { ...subagent, depth }, background: background === true };
            return { agent: await this.startAgent(this.expandHome(cwd), sessionFile, child) } as NodeOps[K]["result"];
          }
        }
      }
      case "agent_attach": {
        const { agent, level } = args as NodeOps["agent_attach"]["args"];
        return this.attach(connection, id, agent, level) as NodeOps[K]["result"] | undefined;
      }
      case "agent_detach": {
        const { agent } = args as NodeOps["agent_detach"]["args"];
        const entry = this.requireAgent(agent);
        entry.attachments.delete(connection);
        this.reportClients(entry);
        return {} as NodeOps[K]["result"];
      }
      case "agent_close": {
        const { agent } = args as NodeOps["agent_close"]["args"];
        await this.requireAgent(agent).link.stop();
        return {} as NodeOps[K]["result"];
      }
      case "files_list": {
        const { path } = args as NodeOps["files_list"]["args"];
        const dir = this.userPath(path);
        const entries = await readdir(dir, { withFileTypes: true });
        const items = await Promise.all(
          entries.map(async (entry) => {
            const full = join(dir, entry.name);
            const info = await stat(full).catch(() => undefined);
            return { name: entry.name, path: full, kind: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file", size: info?.size ?? 0 } as const;
          }),
        );
        return { path: dir, items } as NodeOps[K]["result"];
      }
      case "files_get": {
        const { path } = args as NodeOps["files_get"]["args"];
        const full = this.userPath(path);
        return { path: full, base64: (await readFile(full)).toString("base64") } as NodeOps[K]["result"];
      }
      case "files_put": {
        const { path, base64 } = args as NodeOps["files_put"]["args"];
        const full = this.userPath(path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, Buffer.from(base64, "base64"));
        return { path: full } as NodeOps[K]["result"];
      }
      case "files_upload": {
        const { name, base64 } = args as NodeOps["files_upload"]["args"];
        // the name only: no directories from the client
        const safe = basename(name).replace(/[^\w.@+-]/g, "_") || "file";
        const full = join(this.config.dataDir, "uploads", `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}`);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, Buffer.from(base64, "base64"));
        return { path: full } as NodeOps[K]["result"];
      }
      case "settings_get":
        return { settings: this.settingsOf(connection).read() } as NodeOps[K]["result"];
      case "settings_set": {
        const { key, value } = args as NodeOps["settings_set"]["args"];
        return { settings: this.settingsOf(connection).set(key, value) } as NodeOps[K]["result"];
      }
      case "theme_get": {
        const { name } = args as NodeOps["theme_get"]["args"];
        const chosen = name ?? this.settingsOf(connection).read()["ui.theme"];
        return (await themeColors(this.config.dataDir, typeof chosen === "string" ? chosen : undefined)) as NodeOps[K]["result"];
      }
      default:
        throw new HarnessError("invalid_record", `unknown operation ${String(op satisfies never)}`);
    }
  }

  /** Paths of the files operations: inside the home directory of the node's user. */
  /** "~" and "~/…" are the node user's home; a relative path is relative to it. */
  private expandHome(path: string): string {
    const home = homedir();
    return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(home, path);
  }

  private userPath(path: string): string {
    const home = homedir();
    const full = this.expandHome(path);
    if (full !== home && !full.startsWith(`${home}/`)) {
      throw new HarnessError("forbidden", `${path} is outside ${home}`);
    } else {
      return full;
    }
  }

  /* ----- agents ----- */

  private agentList(): AgentInfo[] {
    return [...this.agents.values()].map((entry) => ({ ...entry.info, summary: entry.summary.current }));
  }

  private requireAgent(id: string): AgentEntry {
    const entry = this.agents.get(id);
    if (entry === undefined) {
      throw new HarnessError("not_found", `no agent ${id} on node ${this.config.name}`);
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

  async startAgent(cwd: string, sessionFile?: string, child?: ChildStart): Promise<AgentInfo> {
    const served = sessionFile !== undefined ? [...this.agents.values()].find((entry) => entry.info.sessionFile === sessionFile) : undefined;
    const max = this.config.maxAgents ?? MAX_AGENTS;
    if (served !== undefined) {
      return { ...served.info, summary: served.summary.current };
    } else if (this.agents.size >= max) {
      // the oldest idle agent makes room; with none idle the start is refused
      const oldest = [...this.agents.values()].filter((entry) => this.idle(entry)).sort((a, b) => a.idleSince(this.clock.now()) - b.idleSince(this.clock.now()))[0];
      if (oldest === undefined) {
        throw new HarnessError("agent_failed", `${max} agents run on node ${this.config.name} and none is idle: close a session first`);
      } else {
        await oldest.link.stop();
        return this.startAgent(cwd, sessionFile, child);
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
          node: this.config.name,
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
      entry.link.send({ type: "harness_snapshot", id: key, limit: 200 });
      return undefined;
    }
  }

  /** A record a client sends to an agent: its id is rewritten so the answer finds its way back. */
  private forward(connection: Connection, agentId: string, record: AgentRecord): void {
    const entry = this.agents.get(agentId);
    if (entry === undefined) {
      connection.send({ k: "hap", node: this.config.name, agent: agentId, rec: { type: "harness_response", id: String(record.id ?? ""), ok: false, error: { code: "not_found", message: `no agent ${agentId}` } } });
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

  /** An agent's own client connection to this node (for its subagents), made on its first frame. */
  private agentConnection(entry: AgentEntry): (frame: ClientFrame) => void {
    const existing = this.agentReceivers.get(entry.info.id);
    if (existing !== undefined) {
      return existing;
    } else {
      let open = true;
      const connection: Connection = {
        id: `agent.${entry.info.id}`,
        user: userInfo().username,
        trusted: true,
        agent: entry.info.id,
        send: (frame) => {
          if (open) {
            entry.link.send({ type: "harness_node", frame });
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
    if (record.type === "harness_node") {
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
        routed.connection.send({ k: "hap", node: this.config.name, agent: entry.info.id, rec: { ...record, id: routed.id } as never });
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
          connection.send({ k: "hap", node: this.config.name, agent: entry.info.id, rec: record as never });
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

  /** Agent events go to every connection allowed here (settings go only to their user: settingsChanged). */
  private broadcast(event: NodeEvent): void {
    for (const { connection, welcomed } of this.connections.values()) {
      if (welcomed && this.allowed(connection)) {
        connection.send({ k: "evt", node: this.config.name, event });
      } else {
        // not through the handshake yet
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.telemetry.log({ event: "node_stop" });
    this.clock.clearTimeout(this.unloadTimer);
    await Promise.all([...this.agents.values()].map((entry) => entry.link.stop()));
    this.locks.releaseAll();
    for (const { connection } of this.connections.values()) {
      connection.close();
    }
  }
}
