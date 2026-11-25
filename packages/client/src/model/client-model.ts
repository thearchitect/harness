// The client's whole view of its nodes: connections, the agents each node runs and their
// summaries, the user's settings, and the agents followed in full (the active tab and a few
// recently visited ones; the rest at summary level). Isomorphic: no Node API.

import type { HapRecord, SnapshotData } from "#protocol/hap.ts";
import type { AgentInfo, AgentSummary, NodeEvent, SessionListItem } from "#protocol/node.ts";
import type { NodeConnection } from "../connection.ts";
import { AgentModel } from "./agent-model.ts";

/** Agents followed in full besides the active one. */
export const FULL_CACHE = 3;

export type AgentKey = string; // `${node}/${agentId}`

export function agentKey(node: string, agentId: string): AgentKey {
  return `${node}/${agentId}`;
}

export class ClientModel {
  readonly connections = new Map<string, NodeConnection>();
  /** The node whose settings this client uses (the local node, or the hub it logged into). */
  home: string | undefined;
  readonly agents = new Map<AgentKey, AgentInfo>();
  readonly full = new Map<AgentKey, AgentModel>();
  /** Most recently used first; the head is the active one. */
  private recent: AgentKey[] = [];
  settings: Record<string, unknown> = {};
  readonly offline = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  async addConnection(connection: NodeConnection, options: { home: boolean }): Promise<string> {
    const node = connection.welcome?.node ?? "node";
    this.connections.set(node, connection);
    this.offline.delete(node);
    if (options.home) {
      this.home = node;
    } else {
      // a remote node besides the home one
    }
    connection.onEvent((from, event) => this.onEvent(from, event));
    connection.onHap((from, agent, record) => this.onHap(from, agent, record));
    connection.onClose((reason) => {
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
      this.changed();
    });
    const { agents } = await connection.request("agents_list", {});
    for (const agent of agents) {
      this.agents.set(agentKey(node, agent.id), agent);
      await connection.request("agent_attach", { agent: agent.id, level: "summary" });
    }
    if (options.home) {
      this.settings = (await connection.request("settings_get", {})).settings;
    } else {
      // settings come from the home node only
    }
    this.changed();
    return node;
  }

  connection(node: string): NodeConnection {
    const connection = this.connections.get(node);
    if (connection === undefined) {
      throw new Error(`node ${node} is not connected${this.offline.has(node) ? `: ${this.offline.get(node)}` : ""}`);
    } else {
      return connection;
    }
  }

  private onEvent(node: string, event: NodeEvent): void {
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
      if ((record as { type?: string }).type === "compaction_end") {
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
    if (existing !== undefined) {
      return existing;
    } else {
      const model = new AgentModel(agentId);
      this.full.set(key, model);
      const { snapshot } = await this.connection(node).request("agent_attach", { agent: agentId, level: "full" });
      if (snapshot !== undefined) {
        model.loadSnapshot(snapshot);
      } else {
        throw new Error(`node ${node} attached ${agentId} without a snapshot`);
      }
      model.onChange(() => this.changed());
      this.changed();
      return model;
    }
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
    if (this.home === undefined) {
      throw new Error("no home node to keep settings");
    } else {
      this.settings = (await this.connection(this.home).request("settings_set", { key, value })).settings;
      this.changed();
    }
  }
}

export function splitKey(key: AgentKey): [string, string] {
  const slash = key.indexOf("/");
  return [key.slice(0, slash), key.slice(slash + 1)];
}
