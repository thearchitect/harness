// The client's whole view of its nodes: connections, the agents each node runs and their
// summaries, the user's settings, and the agents followed in full (the active tab and a few
// recently visited ones; the rest at summary level). Isomorphic: no Node API.

import { SNAPSHOT_ENTRIES, type HapRecord, type SnapshotData } from "#protocol/hap.ts";
import type { AgentInfo, AgentSummary, HubEvent, HubOp, HubOps, SessionListItem } from "#protocol/hub.ts";
import { RequestError, type HubConnection } from "../connection.ts";
import { AgentModel } from "./agent-model.ts";
import { TerminalModel } from "./terminal-model.ts";
import { systemClock, type Clock } from "#protocol/clock.ts";
import { settingRevision } from "#protocol/settings.ts";

/** How often a change of a setting is made again after another client's change came first. */
const UPDATE_ATTEMPTS = 8;

/** One hub as the client reaches it, by the name the client knows it by. */
export class HubApi {
  readonly hub: string;
  readonly connection: HubConnection;

  constructor(node: string, connection: HubConnection) {
    this.hub = node;
    this.connection = connection;
  }

  request<K extends HubOp>(op: K, args: HubOps[K]["args"]): Promise<HubOps[K]["result"]> {
    return this.connection.request(op, args);
  }

  call<T = unknown>(agent: string, record: { type: string; [key: string]: unknown }): Promise<T> {
    return this.connection.call<T>(agent, record);
  }

  tell(agent: string, record: { type: string; [key: string]: unknown }): void {
    this.connection.tell(agent, record);
  }
}

/** Delays between reconnection attempts; the last one repeats. */
export const RECONNECT_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

export type AgentKey = string; // `${node}/${agentId}`

export function agentKey(node: string, agentId: string): AgentKey {
  return `${node}/${agentId}`;
}

/** A stored session's key in `stored`. */
export function storedKey(node: string, file: string): string {
  return `${node}\u0000${file}`;
}

export class ClientModel {
  /** Every hub this client reaches, by name. */
  readonly connections = new Map<string, HubApi>();
  /** The hub whose settings this client uses (the local one). */
  home: string | undefined;
  private homeConnection: HubConnection | undefined;
  readonly agents = new Map<AgentKey, AgentInfo>();
  readonly full = new Map<AgentKey, AgentModel>();
  /** Most recently used first; the head is the active one. */
  private recent: AgentKey[] = [];
  settings: Record<string, unknown> = {};
  readonly offline = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly endpoints = new Set<HubConnection>();
  private disposed = false;

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Adds a connection to a hub. The home connection's settings are the client's. */
  async addConnection(connection: HubConnection, options: { home: boolean }): Promise<string> {
    const name = connection.welcome?.hub ?? "node";
    if (options.home) {
      this.home = name;
      this.homeConnection = connection;
    } else {
      // another machine's hub besides the home one
    }
    connection.onEvent((event) => this.onEvent(name, event));
    connection.onHap((agent, record) => this.onHap(name, agent, record));
    connection.onClose((reason) => {
      if (this.connections.get(name)?.connection === connection) {
        this.dropNode(name, reason);
      } else {
        // replaced by a newer connection meanwhile
      }
      this.changed();
    });
    await this.addNode(new HubApi(name, connection));
    if (options.home) {
      this.settings = (await connection.request("settings_get", {})).settings;
    } else {
      // settings come from the home connection only
    }
    this.changed();
    return name;
  }

  /**
   * A connection that comes back: opened now, and after a loss reopened with backoff — its hubs
   * listed again and the agents this client followed in full re-followed (fresh snapshots).
   */
  async addEndpoint(open: () => Promise<HubConnection>, options: { home: boolean; clock?: Clock }): Promise<string> {
    const clock = options.clock ?? systemClock;
    let attempt = 0;
    const connect = async (): Promise<string> => {
      const connection = await open();
      connection.onClose(() => {
        if (!this.disposed) {
          schedule();
        } else {
          // closed on purpose
        }
      });
      this.endpoints.add(connection);
      const name = await this.addConnection(connection, options);
      attempt = 0;
      for (const key of [...this.recent].reverse()) {
        const [node, agent] = splitKey(key);
        if (this.connections.get(node)?.connection === connection && !this.full.has(key) && this.agents.has(key)) {
          await this.follow(node, agent).catch(() => undefined);
        } else {
          // followed already, or another connection's, or the agent is gone
        }
      }
      return name;
    };
    const schedule = (): void => {
      const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 30_000;
      attempt += 1;
      clock.setTimeout(() => {
        connect().catch(() => (this.disposed ? undefined : schedule()));
      }, delay);
    };
    // a first attempt that fails is retried too; the caller learns why it failed
    return await connect().catch((error: unknown) => {
      schedule();
      throw error;
    });
  }

  /** Closes every endpoint for good (no reconnects). */
  dispose(): void {
    this.disposed = true;
    for (const connection of this.endpoints) {
      connection.close();
    }
  }

  private async addNode(api: HubApi): Promise<void> {
    this.connections.set(api.hub, api);
    this.offline.delete(api.hub);
    const { agents } = await api.request("agents_list", {});
    for (const agent of agents) {
      this.agents.set(agentKey(api.hub, agent.id), agent);
      await api.request("agent_attach", { agent: agent.id, level: "summary" });
    }
  }

  private dropNode(node: string, reason: string): void {
    this.connections.delete(node);
    this.offline.set(node, reason);
    for (const key of [...this.agents.keys()]) {
      if (key.startsWith(`${node}/`)) {
        this.agents.delete(key);
        this.full.delete(key);
      } else {
        // another hub's agent
      }
    }
  }

  connection(node: string): HubApi {
    const connection = this.connections.get(node);
    if (connection === undefined) {
      throw new Error(`hub ${node} is not connected${this.offline.has(node) ? `: ${this.offline.get(node)}` : ""}`);
    } else {
      return connection;
    }
  }

  private onEvent(node: string, event: HubEvent): void {
    switch (event.ev) {
      case "agents": {
        const present = new Set(event.agents.map((agent) => agentKey(node, agent.id)));
        for (const agent of event.agents) {
          const key = agentKey(node, agent.id);
          if (!this.agents.has(key)) {
            void this.connection(node).request("agent_attach", { agent: agent.id, level: "summary" }).catch(() => undefined);
          } else {
            // followed already
          }
          this.agents.set(key, agent);
        }
        for (const key of [...this.agents.keys()]) {
          if (key.startsWith(`${node}/`) && !present.has(key)) {
            this.agents.delete(key);
            this.full.delete(key);
          } else {
            // still there, or another hub's
          }
        }
        break;
      }
      case "summary": {
        const key = agentKey(node, event.agent);
        const agent = this.agents.get(key);
        if (agent !== undefined) {
          this.agents.set(key, { ...agent, summary: event.summary });
        } else {
          // a summary of an agent this client does not list yet
        }
        break;
      }
      case "agent_exited":
        this.agents.delete(agentKey(node, event.agent));
        this.full.delete(agentKey(node, event.agent));
        break;
      case "settings":
        if (node === this.home) {
          this.settings = event.settings;
        } else {
          // another hub's settings: not this client's
        }
        break;
      case "terminal_output":
        this.terminals.get(`${node}\u0000${event.session}`)?.output(event.data);
        return; // the terminal tells when its screen has it
      case "terminal_exit":
        this.terminals.get(`${node}\u0000${event.session}`)?.exited(event.code);
        return;
      default:
        break; // an event of a newer node
    }
    this.changed();
  }

  /** The sessions' terminals this client showed, by node and session. */
  private readonly terminals = new Map<string, TerminalModel>();

  /** A session's terminal on its hub (made at the first show; kept while the client runs). */
  terminal(node: string, session: string, cwd: string): TerminalModel {
    const key = `${node}\u0000${session}`;
    const known = this.terminals.get(key);
    if (known !== undefined) {
      return known;
    } else {
      const made = new TerminalModel(node, session, cwd, () => this.connection(node), () => this.changed());
      this.terminals.set(key, made);
      return made;
    }
  }

  private onHap(node: string, agent: string, record: HapRecord): void {
    const model = this.full.get(agentKey(node, agent));
    if (model !== undefined) {
      model.apply(record);
      const type = (record as { type?: string }).type;
      if (type === "compaction_end" || type === "harness_reload") {
        void this.resync(node, agent);
      } else {
        // the stream keeps the model current
      }
    } else {
      // a record of an agent followed at summary level
    }
  }

  summary(node: string, agentId: string): AgentSummary | undefined {
    return this.agents.get(agentKey(node, agentId))?.summary;
  }

  /** Follows an agent in full (snapshot + stream); the least recently used beyond the cache drop to summaries. */
  async follow(node: string, agentId: string): Promise<AgentModel> {
    const key = agentKey(node, agentId);
    // every agent followed stays followed (the window's tabs, live) until unfollowed
    this.recent = [key, ...this.recent.filter((candidate) => candidate !== key)];
    const existing = this.full.get(key);
    const loading = this.loading.get(key);
    if (loading !== undefined) {
      return loading; // a follow of it is under way: its snapshot comes with it
    } else if (existing !== undefined) {
      return existing;
    } else {
      // what was read from its file goes on as the agent's: the same items, nothing drawn again
      const file = this.agents.get(key)?.sessionFile;
      const stored = file !== undefined ? this.stored.get(storedKey(node, file)) : undefined;
      const model = stored?.model ?? new AgentModel(agentId);
      if (stored !== undefined && file !== undefined) {
        model.adopt(agentId);
        this.stored.delete(storedKey(node, file));
      } else {
        // nothing read before
      }
      this.full.set(key, model);
      const load = (async (): Promise<AgentModel> => {
        const { snapshot } = await this.connection(node).request("agent_attach", { agent: agentId, level: "full" });
        if (snapshot !== undefined) {
          model.loadSnapshot(snapshot);
        } else {
          throw new Error(`hub ${node} attached ${agentId} without a snapshot`);
        }
        model.onChange(() => this.changed());
        this.changed();
        return model;
      })();
      this.loading.set(key, load);
      try {
        return await load;
      } finally {
        this.loading.delete(key);
      }
    }
  }

  /** Stops following an agent in full: it drops to its summary; following it again takes a fresh snapshot. */
  /** Follows under way, by agent key. */
  private readonly loading = new Map<string, Promise<AgentModel>>();

  async unfollow(node: string, agentId: string): Promise<void> {
    const key = agentKey(node, agentId);
    this.full.delete(key);
    this.recent = this.recent.filter((candidate) => candidate !== key);
    await this.connection(node).request("agent_attach", { agent: agentId, level: "summary" });
    this.changed();
  }

  private async resync(node: string, agentId: string): Promise<void> {
    const model = this.full.get(agentKey(node, agentId));
    if (model !== undefined) {
      const snapshot = await this.connection(node).call<SnapshotData>(agentId, { type: "harness_snapshot", limit: SNAPSHOT_ENTRIES });
      model.loadSnapshot(snapshot);
    } else {
      // no longer followed
    }
  }

  /**
   * A `claude` subagent's transcript, kept by the session that runs it (followed in full): the model
   * at once, its snapshot loading into it; the parent's stream keeps it current.
   */
  claudeTranscript(node: string, agentId: string, session: string): AgentModel | undefined {
    const parent = this.full.get(agentKey(node, agentId));
    const known = parent?.claude.get(session);
    if (parent === undefined || known !== undefined) {
      return known;
    } else {
      const model = new AgentModel(`${agentId}/claude/${session}`);
      parent.claude.set(session, model);
      model.onChange(() => this.changed());
      void this.connection(node)
        .call<{ entries: unknown[]; cursor?: string; streaming?: unknown; model?: string; costUsd: number }>(agentId, { type: "harness_subagent_snapshot", session, limit: SNAPSHOT_ENTRIES })
        .then((snapshot) => {
          model.claudeInfo = { ...(snapshot.model !== undefined ? { model: snapshot.model } : {}), costUsd: snapshot.costUsd };
          model.loadEntries(snapshot.entries, snapshot.cursor, snapshot.streaming);
        })
        .catch((error: unknown) => model.notice("error", `the subagent's transcript: ${error instanceof Error ? error.message : String(error)}`));
      return model;
    }
  }

  async loadOlder(node: string, agentId: string): Promise<void> {
    const model = this.full.get(agentKey(node, agentId));
    if (model !== undefined && model.cursor !== undefined) {
      const older = await this.connection(node).call<{ entries: unknown[]; cursor?: string }>(agentId, { type: "harness_entries_before", cursor: model.cursor, limit: SNAPSHOT_ENTRIES });
      model.prepend(older.entries, older.cursor);
    } else {
      // nothing older, or not followed
    }
  }

  /** Every older entry of a followed agent, page by page. */
  async loadAll(node: string, agentId: string): Promise<void> {
    while (this.full.get(agentKey(node, agentId))?.cursor !== undefined) {
      await this.loadOlder(node, agentId);
    }
  }

  /** Stored sessions read without their agents (session_read), by node and file. */
  readonly stored = new Map<string, { model: AgentModel; mtime: number; checked: number }>();

  storedModel(node: string, file: string | undefined): AgentModel | undefined {
    return file !== undefined ? this.stored.get(storedKey(node, file))?.model : undefined;
  }

  /**
   * Reads a stored session whole, page by page, unless what was read is current (its file's mtime);
   * a changed file is read again into the same model (the items it had stay).
   */
  async readStored(node: string, file: string, now: number): Promise<void> {
    const key = storedKey(node, file);
    const known = this.stored.get(key);
    const api = this.connection(node);
    const newest = await api.request("session_read", { file, limit: SNAPSHOT_ENTRIES });
    if (known !== undefined && known.mtime === newest.mtime && known.model.cursor === undefined) {
      known.checked = now;
    } else {
      const model = known?.model ?? new AgentModel("");
      model.loadNewest(newest.entries, newest.cursor);
      this.stored.set(key, { model, mtime: newest.mtime, checked: now });
      while (model.cursor !== undefined && this.stored.get(key)?.model === model) {
        const older = await api.request("session_read", { file, cursor: model.cursor, limit: SNAPSHOT_ENTRIES });
        model.prepend(older.entries, older.cursor);
      }
      this.changed();
    }
  }

  async sessions(node: string): Promise<SessionListItem[]> {
    return (await this.connection(node).request("sessions_list", {})).sessions;
  }

  async setting(key: string, value: unknown): Promise<void> {
    this.settings = (await this.homeRequest("settings_set", { key, value })).settings;
    this.changed();
  }

  /**
   * Changes a setting from its current value: when another client changed it meanwhile (conflict),
   * the change applies again to the value the hub has now. For values clients change together
   * (ui.tabs): no change of another client is lost.
   */
  async updateSetting<T>(key: string, change: (current: T | undefined) => T): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const base = this.settings[key] as T | undefined;
      try {
        this.settings = (await this.homeRequest("settings_set", { key, value: change(base), ifRevision: settingRevision(base) })).settings;
        this.changed();
        return;
      } catch (error) {
        if (error instanceof RequestError && error.code === "conflict" && attempt < UPDATE_ATTEMPTS) {
          this.settings = (await this.homeRequest("settings_get", {})).settings;
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * An operation of the home hub itself (settings, themes): this machine's hub, which keeps the
   * user's settings.
   */
  homeRequest<K extends HubOp>(op: K, args: HubOps[K]["args"]): Promise<HubOps[K]["result"]> {
    if (this.homeConnection === undefined) {
      throw new Error("no home node to keep settings");
    } else {
      return this.homeConnection.request(op, args);
    }
  }
}

export function splitKey(key: AgentKey): [string, string] {
  const slash = key.indexOf("/");
  return [key.slice(0, slash), key.slice(slash + 1)];
}
