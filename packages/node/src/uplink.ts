// A node's link to a hub: it connects out (so a node behind NAT needs no open port), introduces
// itself with its key, and serves the hub's clients as connections of their own — each routed
// channel one connection with its hub user, checked against the node's own user list. The link
// reconnects with backoff while the node runs.

import { decodeRecord, encodeRecord } from "#protocol/framing.ts";
import type { ClientFrame, HubToNodeFrame } from "#protocol/node.ts";
import { PROTOCOL_VERSION } from "#protocol/version.ts";
import type { Connection, HarnessNode } from "./node.ts";

export type UplinkOptions = {
  /** The hub's WebSocket base: ws(s)://host[:port]. */
  url: string;
  /** The node's key, read at every attempt (a key file may appear or change later). */
  key: string | (() => string);
  onState?: (state: "connected" | "disconnected", detail?: string) => void;
};

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export class Uplink {
  private readonly node: HarnessNode;
  private readonly options: UplinkOptions;
  private socket: WebSocket | undefined;
  private readonly channels = new Map<string, { connection: Connection; receive(frame: ClientFrame): void }>();
  private attempt = 0;
  private stopped = false;
  private timer: unknown;

  constructor(node: HarnessNode, options: UplinkOptions) {
    this.node = node;
    this.options = options;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    let key: string;
    try {
      key = typeof this.options.key === "string" ? this.options.key : this.options.key();
    } catch (error) {
      this.options.onState?.("disconnected", error instanceof Error ? error.message : String(error));
      this.retry();
      return;
    }
    const socket = new WebSocket(`${this.options.url.replace(/\/$/, "")}/uplink`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(encodeRecord({ k: "hello", protocol: PROTOCOL_VERSION, client: "node", token: key }));
    });
    socket.addEventListener("message", (event) => {
      const decoded = decodeRecord(String(event.data));
      if (decoded.ok) {
        this.receive(decoded.record as HubToNodeFrame);
      } else {
        // a malformed frame from the hub: ignored, the link stays
      }
    });
    socket.addEventListener("close", () => {
      for (const { connection } of this.channels.values()) {
        this.node.disconnect(connection);
      }
      this.channels.clear();
      this.options.onState?.("disconnected");
      this.retry();
    });
    socket.addEventListener("error", () => {
      // "close" follows and schedules the next attempt
    });
  }

  private retry(): void {
    if (!this.stopped) {
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
      this.attempt += 1;
      this.timer = this.node.clock.setTimeout(() => this.connect(), delay);
    } else {
      // stopped on purpose
    }
  }

  private receive(frame: HubToNodeFrame): void {
    switch (frame.k) {
      case "welcome":
        this.attempt = 0;
        this.options.onState?.("connected");
        break;
      case "refused":
        this.options.onState?.("disconnected", frame.error.message);
        this.stopped = frame.error.code === "unauthorized";
        this.socket?.close();
        break;
      case "route": {
        const channel = this.channels.get(frame.conn) ?? this.open(frame.conn, frame.user);
        channel.receive(frame.frame);
        break;
      }
      case "route_close": {
        const channel = this.channels.get(frame.conn);
        if (channel !== undefined) {
          this.channels.delete(frame.conn);
          this.node.disconnect(channel.connection);
        } else {
          // never opened
        }
        break;
      }
      default:
        break; // a frame of a newer protocol
    }
  }

  private open(conn: string, user: string): { connection: Connection; receive(frame: ClientFrame): void } {
    const connection: Connection = {
      id: `hub:${conn}`,
      user,
      trusted: false,
      send: (frame) => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(encodeRecord({ k: "route", conn, frame }));
        } else {
          // the link is down: the client sees the node offline
        }
      },
      close: () => {
        this.channels.delete(conn);
      },
    };
    const channel = { connection, receive: this.node.accept(connection) };
    this.channels.set(conn, channel);
    return channel;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.node.clock.clearTimeout(this.timer);
    } else {
      // no reconnect pending
    }
    this.socket?.close();
  }
}
