// The hub role of a node: it authenticates users' devices and other nodes, keeps which nodes are
// online, routes a client's frames for another node over that node's uplink (without reading
// them), and keeps each hub user's UI settings. The node checks the user again on its side.

import { join } from "node:path";
import type { ClientFrame, HubToNodeFrame, NodeFrame, NodeInfo } from "#protocol/node.ts";
import { PROTOCOL_VERSION } from "#protocol/version.ts";
import { HubAuth } from "./auth.ts";
import type { Connection, HarnessNode, HubRole } from "./node.ts";
import { SettingsStore } from "./settings.ts";

/** A node's live link to this hub. */
export type UplinkPeer = { name: string; send(frame: HubToNodeFrame): void; close(): void };

export class Hub implements HubRole {
  readonly auth: HubAuth;
  private readonly node: HarnessNode;
  private readonly uplinks = new Map<string, UplinkPeer>();
  /** Client connection id -> the connection and the nodes it has a channel to. */
  private readonly clients = new Map<string, { connection: Connection; nodes: Set<string> }>();
  private readonly stores = new Map<string, SettingsStore>();

  constructor(node: HarnessNode) {
    this.node = node;
    this.auth = new HubAuth(node.config.dataDir);
    node.hub = this;
  }

  nodes(user: string): NodeInfo[] {
    return this.auth
      .nodes()
      .filter((candidate) => candidate.users.includes(user) && candidate.name !== this.node.config.name)
      .map((candidate) => ({ name: candidate.name, online: this.uplinks.has(candidate.name), roles: ["node"] }));
  }

  mayUseLocal(user: string): boolean {
    return this.isAdmin(user) || this.auth.mayUse(user, this.node.config.name);
  }

  isAdmin(user: string): boolean {
    return this.auth.users().some((candidate) => candidate.name === user && candidate.admin);
  }

  settingsFor(user: string): SettingsStore {
    const existing = this.stores.get(user);
    if (existing !== undefined) {
      return existing;
    } else {
      const store = new SettingsStore(join(this.node.config.dataDir, "users", user));
      store.onChange((settings) => this.node.settingsChanged(store, settings));
      this.stores.set(user, store);
      return store;
    }
  }

  route(connection: Connection, frame: ClientFrame & { node?: string }): void {
    const target = frame.node ?? "";
    const uplink = this.uplinks.get(target);
    if (!this.auth.mayUse(connection.user, target)) {
      this.node.refuse(connection, frame, { code: "forbidden", message: `${connection.user} may not use node ${target}` });
    } else if (uplink === undefined) {
      this.node.refuse(connection, frame, { code: "node_offline", message: `node ${target} is offline` });
    } else {
      const client = this.clients.get(connection.id) ?? { connection, nodes: new Set<string>() };
      this.clients.set(connection.id, client);
      if (!client.nodes.has(target)) {
        // the node's own handshake for this client: its welcome stays at the hub
        client.nodes.add(target);
        uplink.send({ k: "route", conn: connection.id, user: connection.user, frame: { k: "hello", protocol: PROTOCOL_VERSION, client: "hub" } });
      } else {
        // the channel is open
      }
      uplink.send({ k: "route", conn: connection.id, user: connection.user, frame });
    }
  }

  /** A frame from a node for one of the hub's clients. */
  fromNode(node: string, conn: string, frame: NodeFrame): void {
    const client = this.clients.get(conn);
    if (client === undefined || frame.k === "welcome") {
      return; // the client is gone, or the node's welcome of a routed channel
    } else if (frame.k === "refused") {
      client.nodes.delete(node);
      client.connection.send({ k: "evt", node, event: { ev: "refused", error: frame.error } });
    } else {
      client.connection.send(frame);
    }
  }

  disconnect(connection: Connection): void {
    const client = this.clients.get(connection.id);
    if (client !== undefined) {
      this.clients.delete(connection.id);
      for (const node of client.nodes) {
        this.uplinks.get(node)?.send({ k: "route_close", conn: connection.id });
      }
    } else {
      // never routed anywhere
    }
  }

  /** A node came online; an older link of the same node is replaced. */
  attachUplink(peer: UplinkPeer): void {
    this.uplinks.get(peer.name)?.close();
    this.uplinks.set(peer.name, peer);
    this.presenceChanged();
  }

  detachUplink(peer: UplinkPeer): void {
    if (this.uplinks.get(peer.name) === peer) {
      this.uplinks.delete(peer.name);
      for (const client of this.clients.values()) {
        client.nodes.delete(peer.name);
      }
      this.presenceChanged();
    } else {
      // replaced by a newer link
    }
  }

  private presenceChanged(): void {
    for (const client of this.clients.values()) {
      client.connection.send({ k: "evt", node: this.node.config.name, event: { ev: "nodes", nodes: this.nodes(client.connection.user) } });
    }
  }

  /** Remembers a client so presence changes reach it even before it routes anything. */
  track(connection: Connection): void {
    if (!this.clients.has(connection.id)) {
      this.clients.set(connection.id, { connection, nodes: new Set() });
    } else {
      // tracked already
    }
  }
}
