// The client's whole view of its nodes: connections, the agents each node runs and their
// summaries, the user's settings, and the agents followed in full (the active tab and a few
// recently visited ones; the rest at summary level). Isomorphic: no Node API.

import type { HapRecord, SnapshotData } from "#protocol/hap.ts";
import type { AgentInfo, AgentSummary, NodeEvent, NodeInfo, NodeOp, NodeOps, SessionListItem } from "#protocol/node.ts";
import type { NodeConnection } from "../connection.ts";
import { AgentModel } from "./agent-model.ts";
import { systemClock, type Clock } from "#protocol/clock.ts";

/** One node as the client reaches it: its own connection, or a hub's connection routing to it. */
export class NodeApi {
  readonly node: string;
  readonly connection: NodeConnection;
  /** Frames name the node only when a hub routes them. */
  private readonly target: string | undefined;

  constructor(node: string, connection: NodeConnection, routed: boolean) {
    this.node = node;
    this.connection = connection;
    this.target = routed ? node : undefined;
  }

  request<K extends NodeOp>(op: K, args: NodeOps[K]["args"]): Promise<NodeOps[K]["result"]> {
    return this.connection.request(op, args, this.target);
  }

  call<T = unknown>(agent: string, record: { type: string; [key: string]: unknown }): Promise<T> {
    return this.connection.call<T>(agent, record, this.target);
  }

  tell(agent: string, record: { type: string; [key: string]: unknown }): void {
    this.connection.tell(agent, record, this.target);
  }
}

/** Agents followed in full besides the active one. */
export const FULL_CACHE = 3;

/** Delays between reconnection attempts; the last one repeats. */
export const RECONNECT_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

export type AgentKey = string; // `${node}/${agentId}`

export function agentKey(node: string, agentId: string): AgentKey {
  return `${node}/${agentId}`;
}

export class ClientModel {
  /** Every node this client reaches, by name. */
  readonly connections = new Map<string, NodeApi>();
  /** The node whose settings this client uses (the local node, or the hub it logged into). */
  home: string | undefined;
  private homeConnection: NodeConnection | undefined;
  /** Nodes known through hubs, online or not. */
  readonly nodes = new Map<string, NodeInfo>();
  readonly agents = new Map<AgentKey, AgentInfo>();
  readonly full = new Map<AgentKey, AgentModel>();
  /** Most recently used first; the head is the active one. */
  private recent: AgentKey[] = [];
  settings: Record<string, unknown> = {};
  readonly offline = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly endpoints = new Set<NodeConnection>();
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

  /**
   * Adds a connection: to a node, or to a hub and every node it routes to for this user. The
   * home connection's settings are the client's (the local node's, or the hub user's).
   */
  async addConnection(connection: NodeConnection, options: { home: boolean }): Promise<string> {
    const entry = connection.welcome?.node ?? "node";
    if (options.home) {
      this.home = entry;
      this.homeConnection = connection;
    } else {
      // a remote node or hub besides the home one
    }
    connection.onEvent((from, event) => this.onEvent(from, event, connection));
    connection.onHap((from, agent, record) => this.onHap(from, agent, record));
    connection.onClose((reason) => {
      for (const [name, api] of [...this.connections]) {
        if (api.connection === connection) {
          this.dropNode(name, reason);
        } else {
          // reached through another connection
        }
      }
      this.changed();
    });
    const { nodes } = await connection.request("nodes_list", {});
    for (const info of nodes) {
      this.nodes.set(info.name, info);
      if (info.online) {
        await this.addNode(new NodeApi(info.name, connection, info.name !== entry));
      } else {
        this.offline.set(info.name, `node ${info.name} is offline`);
      }
    }
    if (options.home) {
      this.settings = (await connection.request("settings_get", {})).settings;
    } else {
      // settings come from the home connection only
    }
    this.changed();
    return entry;
  }

  /**
   * A connection that comes back: opened now, and after a loss reopened with backoff — its nodes
   * listed again and the agents this client followed in full re-followed (fresh snapshots).
   */
  async addEndpoint(open: () => Promise<NodeConnection>, options: { home: boolean; clock?: Clock }): Promise<string> {
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

  private async addNode(api: NodeApi): Promise<void> {
    this.connections.set(api.node, api);
    this.offline.delete(api.node);
    const { agents } = await api.request("agents_list", {});
    for (const agent of agents) {
      this.agents.set(agentKey(api.node, agent.id), agent);
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
        // another node's agent
      }
    }
  }

  connection(node: string): NodeApi {
    const connection = this.connections.get(node);
    if (connection === undefined) {
      throw new Error(`node ${node} is not connected${this.offline.has(node) ? `: ${this.offline.get(node)}` : ""}`);
    } else {
      return connection;
    }
  }

  private onEvent(node: string, event: NodeEvent, via: NodeConnection): void {
    switch (event.ev) {
      case "nodes":
        for (const info of event.nodes) {
          this.nodes.set(info.name, info);
          if (info.online && !this.connections.has(info.name)) {
            void this.addNode(new NodeApi(info.name, via, true))
              .then(() => this.changed())
              .catch((error: unknown) => this.offline.set(info.name, error instanceof Error ? error.message : String(error)));
          } else if (!info.online && this.connections.get(info.name)?.connection === via) {
            this.dropNode(info.name, `node ${info.name} is offline`);
          } else {
            // no change for this node
          }
        }
        break;
      case "refused":
        this.dropNode(node, event.error.message);
        break;
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
            // still there, or another node's
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
          // another node's settings: not this client's
        }
        break;
      default:
        break; // an event of a newer node
    }
    this.changed();
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
    this.recent = [key, ...this.recent.filter((candidate) => candidate !== key)];
    for (const stale of this.recent.slice(FULL_CACHE + 1)) {
      const [staleNode, staleAgent] = splitKey(stale);
      this.full.delete(stale);
      void this.connections.get(staleNode)?.request("agent_attach", { agent: staleAgent, level: "summary" }).catch(() => undefined);
    }
    this.recent = this.recent.slice(0, FULL_CACHE + 1);
    const existing = this.full.get(key);
    const loading = this.loading.get(key);
    if (loading !== undefined) {
      return loading; // a follow of it is under way: its snapshot comes with it
    } else if (existing !== undefined) {
      return existing;
    } else {
      const model = new AgentModel(agentId);
      this.full.set(key, model);
      const load = (async (): Promise<AgentModel> => {
        const { snapshot } = await this.connection(node).request("agent_attach", { agent: agentId, level: "full" });
        if (snapshot !== undefined) {
          model.loadSnapshot(snapshot);
        } else {
          throw new Error(`node ${node} attached ${agentId} without a snapshot`);
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
      const snapshot = await this.connection(node).call<SnapshotData>(agentId, { type: "harness_snapshot", limit: 200 });
      model.loadSnapshot(snapshot);
    } else {
      // no longer followed
    }
  }

  async loadOlder(node: string, agentId: string): Promise<void> {
    const model = this.full.get(agentKey(node, agentId));
    if (model !== undefined && model.cursor !== undefined) {
      const older = await this.connection(node).call<{ entries: unknown[]; cursor?: string }>(agentId, { type: "harness_entries_before", cursor: model.cursor, limit: 200 });
      model.prepend(older.entries, older.cursor);
    } else {
      // nothing older, or not followed
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
   * An operation of the home endpoint itself (settings, themes): the node or hub this client came in
   * through, which keeps the user's settings even when the user may not run agents on it.
   */
  homeRequest<K extends NodeOp>(op: K, args: NodeOps[K]["args"]): Promise<NodeOps[K]["result"]> {
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
