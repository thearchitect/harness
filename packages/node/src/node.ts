// A harness node: the agents of one OS user on one machine and the clients connected to them.
// Every endpoint (unix socket, WebSocket, in-process) hands its connections here; the node speaks
// the node protocol on them, runs agents as child processes, and fans each agent's HAP stream out
// to the connections attached to it — the whole stream ("full") or its summary ("summary").

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, toProtocolError } from "#protocol/errors.ts";
import type { AgentInfo, AttachLevel, ClientFrame, NodeEvent, NodeFrame, NodeOp, NodeOps } from "#protocol/node.ts";
import { NODE_OPS } from "#protocol/node.ts";
import { compatibleProtocol, PROTOCOL_VERSION } from "#protocol/version.ts";
import { AgentLink, type AgentRecord } from "./agent-link.ts";
import { listSessions, SessionLocks } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { SummaryTracker } from "./summary.ts";

/** One client connection, whatever carries it. */
export interface Connection {
  readonly id: string;
  send(frame: NodeFrame): void;
  close(): void;
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
};

type Attachment = { level: AttachLevel; live: boolean };

type AgentEntry = {
  info: AgentInfo;
  link: AgentLink;
  summary: SummaryTracker;
  attachments: Map<Connection, Attachment>;
  /** Rewritten request id -> the connection and its own id. */
  requests: Map<string, { connection: Connection; id: unknown }>;
  summaryTimer?: ReturnType<typeof setTimeout>;
  summaryDue: boolean;
  lastSummaryAt: number;
};

/** The agent of this checkout or bundle: node running packages/agent/src/main.ts. */
export function defaultAgentCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("../../agent/src/main.ts", import.meta.url))];
}

export class HarnessNode {
  readonly config: NodeConfig;
  private readonly agents = new Map<string, AgentEntry>();
  private readonly connections = new Map<string, { connection: Connection; welcomed: boolean }>();
  private readonly locks: SessionLocks;
  readonly settings: SettingsStore;
  private counter = 0;

  constructor(config: NodeConfig) {
    this.config = config;
    this.locks = new SessionLocks(config.dataDir);
    this.settings = new SettingsStore(config.dataDir);
    this.settings.onChange((settings) => this.broadcast({ ev: "settings", settings }));
  }

  /* ----- connections ----- */

  accept(connection: Connection): (frame: ClientFrame) => void {
    this.connections.set(connection.id, { connection, welcomed: false });
    return (frame) => void this.receive(connection, frame);
  }

  disconnect(connection: Connection): void {
    this.connections.delete(connection.id);
    for (const entry of this.agents.values()) {
      entry.attachments.delete(connection);
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
    if (state === undefined) {
      return; // closed meanwhile
    } else if (!state.welcomed) {
      if (frame.k !== "hello") {
        connection.send({ k: "refused", error: { code: "invalid_record", message: "the first frame must be hello" } });
        connection.close();
      } else if (!compatibleProtocol(frame.protocol)) {
        connection.send({ k: "refused", error: { code: "version_mismatch", message: `protocol ${frame.protocol} is not ${PROTOCOL_VERSION}: update the client or the node` } });
        connection.close();
      } else {
        state.welcomed = true;
        connection.send({ k: "welcome", protocol: PROTOCOL_VERSION, harness: this.config.harnessVersion, node: this.config.name, user: process.env.USER ?? "" });
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
      case "nodes_list":
        return { nodes: [{ name: this.config.name, online: true, roles: ["node"] }] } as NodeOps[K]["result"];
      case "sessions_list": {
        const { cwd } = args as NodeOps["sessions_list"]["args"];
        const sessions = await listSessions(this.config.dataDir, cwd);
        const served = new Map([...this.agents.values()].map((entry) => [entry.info.sessionId, entry.info.id]));
        return { sessions: sessions.map((session) => ({ ...session, agent: served.get(session.id) })) } as NodeOps[K]["result"];
      }
      case "agents_list":
        return { agents: this.agentList() } as NodeOps[K]["result"];
      case "agent_start": {
        const { cwd, sessionFile, parent } = args as NodeOps["agent_start"]["args"];
        return { agent: await this.startAgent(cwd, sessionFile, parent) } as NodeOps[K]["result"];
      }
      case "agent_attach": {
        const { agent, level } = args as NodeOps["agent_attach"]["args"];
        return this.attach(connection, id, agent, level) as NodeOps[K]["result"] | undefined;
      }
      case "agent_detach": {
        const { agent } = args as NodeOps["agent_detach"]["args"];
        this.requireAgent(agent).attachments.delete(connection);
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
      case "settings_get":
        return { settings: this.settings.read() } as NodeOps[K]["result"];
      case "settings_set": {
        const { key, value } = args as NodeOps["settings_set"]["args"];
        return { settings: this.settings.set(key, value) } as NodeOps[K]["result"];
      }
      default:
        throw new HarnessError("invalid_record", `unknown operation ${String(op satisfies never)}`);
    }
  }

  /** Paths of the files operations: inside the home directory of the node's user. */
  private userPath(path: string): string {
    const home = homedir();
    const full = resolve(home, path);
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

  async startAgent(cwd: string, sessionFile?: string, parent?: string): Promise<AgentInfo> {
    const served = sessionFile !== undefined ? [...this.agents.values()].find((entry) => entry.info.sessionFile === sessionFile) : undefined;
    if (served !== undefined) {
      return { ...served.info, summary: served.summary.current };
    } else {
      this.counter += 1;
      const id = `a${this.counter}-${randomUUID().slice(0, 4)}`;
      const link = new AgentLink({
        command: this.config.agentCommand ?? defaultAgentCommand(),
        cwd,
        sessionFile,
        env: { ...process.env, HARNESS_HOME: this.config.dataDir, ...this.config.agentEnv },
        logPath: join(this.config.dataDir, "log", "agents", `${id}.log`),
      });
      const summary = new SummaryTracker(Date.now());
      const hello = await new Promise<AgentRecord>((resolveHello, reject) => {
        const off = link.onRecord((record) => {
          if (record.type === "harness_hello") {
            off();
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
      summary.apply(hello, Date.now());
      const entry: AgentEntry = {
        info: {
          id,
          node: this.config.name,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          cwd: session.cwd,
          name: session.sessionName,
          parent,
          startedAt: Date.now(),
          summary: summary.current,
        },
        link,
        summary,
        attachments: new Map(),
        requests: new Map(),
        summaryDue: false,
        lastSummaryAt: 0,
      };
      this.agents.set(id, entry);
      link.onRecord((record) => this.fromAgent(entry, record));
      link.onExit((code, error) => {
        this.agents.delete(id);
        this.locks.release(entry.info.sessionId);
        if (entry.summaryTimer !== undefined) {
          clearTimeout(entry.summaryTimer);
        } else {
          // no summary pending
        }
        this.broadcast({ ev: "agent_exited", agent: id, code, error });
        this.broadcast({ ev: "agents", agents: this.agentList() });
      });
      this.broadcast({ ev: "agents", agents: this.agentList() });
      return { ...entry.info, summary: summary.current };
    }
  }

  private attach(connection: Connection, id: string, agentId: string, level: AttachLevel): { agent: AgentInfo; snapshot?: unknown } | undefined {
    const entry = this.requireAgent(agentId);
    if (level === "summary") {
      entry.attachments.set(connection, { level, live: true });
      return { agent: { ...entry.info, summary: entry.summary.current } };
    } else {
      // full: the snapshot answers the attach; events after it go to the connection
      entry.attachments.set(connection, { level: "full", live: false });
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

  private fromAgent(entry: AgentEntry, record: AgentRecord): void {
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
      if (entry.summary.apply(record, Date.now())) {
        this.scheduleSummary(entry);
      } else {
        // the summary did not change
      }
    }
  }

  /** At most one summary per interval per agent; the last change always goes out. */
  private scheduleSummary(entry: AgentEntry): void {
    const interval = this.config.summaryIntervalMs ?? 250;
    const wait = entry.lastSummaryAt + interval - Date.now();
    if (entry.summaryTimer !== undefined) {
      entry.summaryDue = true;
    } else if (wait <= 0) {
      this.sendSummary(entry);
    } else {
      entry.summaryTimer = setTimeout(() => {
        entry.summaryTimer = undefined;
        this.sendSummary(entry);
      }, wait);
    }
  }

  private sendSummary(entry: AgentEntry): void {
    entry.lastSummaryAt = Date.now();
    entry.summaryDue = false;
    this.broadcast({ ev: "summary", agent: entry.info.id, summary: entry.summary.current });
  }

  private broadcast(event: NodeEvent): void {
    for (const { connection, welcomed } of this.connections.values()) {
      if (welcomed) {
        connection.send({ k: "evt", node: this.config.name, event });
      } else {
        // not through the handshake yet
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map((entry) => entry.link.stop()));
    this.locks.releaseAll();
    for (const { connection } of this.connections.values()) {
      connection.close();
    }
  }
}
