// A client's connection to a node: the handshake, operations with answers, node events,
// and the HAP records of attached agents. Transport-neutral and isomorphic: a unix socket, a
// WebSocket and an in-process hub all deliver frames through the same Transport.

import type { ProtocolError } from "#protocol/errors.ts";
import type { HapRecord } from "#protocol/hap.ts";
import type { ClientCapability, HubEvent, HubFrame, HubOp, HubOps, Transport } from "#protocol/hub.ts";
import { PROTOCOL_VERSION } from "#protocol/version.ts";

export type { Transport };

export class RequestError extends Error {
  readonly code: ProtocolError["code"];

  constructor(error: ProtocolError) {
    super(error.message);
    this.code = error.code;
  }
}

export type Welcome = Extract<HubFrame, { k: "welcome" }>;

type Waiter = { resolve(data: unknown): void; reject(error: Error): void };

export class HubConnection {
  private readonly transport: Transport;
  private readonly waiters = new Map<string, Waiter>();
  private readonly hapWaiters = new Map<string, Waiter>();
  private readonly eventListeners = new Set<(event: HubEvent) => void>();
  private readonly hapListeners = new Set<(agent: string, record: HapRecord) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private counter = 0;
  welcome: Welcome | undefined;
  closed = false;

  private constructor(transport: Transport) {
    this.transport = transport;
    transport.onFrame((frame) => this.receive(frame));
    transport.onClose((reason) => {
      this.closed = true;
      const error = new Error(`connection closed: ${reason}`);
      // closed before the welcome: the handshake fails with why (no hub there, ssh refused)
      this.handshake?.reject(new Error(reason));
      this.handshake = undefined;
      for (const waiter of [...this.waiters.values(), ...this.hapWaiters.values()]) {
        waiter.reject(error);
      }
      this.waiters.clear();
      this.hapWaiters.clear();
      for (const listener of this.closeListeners) {
        listener(reason);
      }
    });
  }

  /** Connects and exchanges hello/welcome; rejects with the hub's reason when refused. */
  static open(transport: Transport, client: string, token?: string, capabilities?: ClientCapability[]): Promise<HubConnection> {
    const connection = new HubConnection(transport);
    return new Promise((resolve, reject) => {
      connection.handshake = { resolve: () => resolve(connection), reject };
      transport.send({ k: "hello", protocol: PROTOCOL_VERSION, client, token, ...(capabilities !== undefined ? { capabilities } : {}) });
    });
  }

  private handshake: { resolve(): void; reject(error: Error): void } | undefined;

  private receive(frame: HubFrame): void {
    switch (frame.k) {
      case "welcome":
        this.welcome = frame;
        this.handshake?.resolve();
        this.handshake = undefined;
        break;
      case "refused":
        this.handshake?.reject(new RequestError(frame.error));
        this.handshake = undefined;
        break;
      case "res": {
        const waiter = this.waiters.get(frame.id);
        if (waiter !== undefined) {
          this.waiters.delete(frame.id);
          if (frame.ok) {
            waiter.resolve(frame.data);
          } else {
            waiter.reject(new RequestError(frame.error));
          }
        } else {
          // an answer nobody waits for (a protocol error without an id)
        }
        break;
      }
      case "evt":
        for (const listener of this.eventListeners) {
          listener(frame.event);
        }
        break;
      case "hap": {
        const record = frame.rec as { type?: string; id?: unknown; ok?: boolean; success?: boolean; data?: unknown; error?: unknown };
        const key = typeof record.id === "string" ? `${frame.agent}.${record.id}` : undefined;
        const waiter = key !== undefined && (record.type === "harness_response" || record.type === "response") ? this.hapWaiters.get(key) : undefined;
        if (waiter !== undefined && key !== undefined) {
          this.hapWaiters.delete(key);
          if (record.ok === true || record.success === true) {
            waiter.resolve(record.data);
          } else if (record.type === "harness_response") {
            waiter.reject(new RequestError(record.error as ProtocolError));
          } else {
            waiter.reject(new RequestError({ code: "agent_failed", message: String(record.error) }));
          }
        } else {
          for (const listener of this.hapListeners) {
            listener(frame.agent, frame.rec);
          }
        }
        break;
      }
      default:
        break; // a frame of a newer protocol: ignored
    }
  }

  request<K extends HubOp>(op: K, args: HubOps[K]["args"]): Promise<HubOps[K]["result"]> {
    this.counter += 1;
    const id = `r${this.counter}`;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve: (data) => resolve(data as HubOps[K]["result"]), reject });
      this.transport.send({ k: "req", id, op, args });
    });
  }

  /** Sends a HAP request or pi command to an agent and waits for its answer. */
  call<T = unknown>(agent: string, record: { type: string; [key: string]: unknown }): Promise<T> {
    this.counter += 1;
    const id = `h${this.counter}`;
    return new Promise((resolve, reject) => {
      this.hapWaiters.set(`${agent}.${id}`, { resolve: (data) => resolve(data as T), reject });
      this.transport.send({ k: "hap", agent, rec: { ...record, id } as HapRecord });
    });
  }

  /** Sends a record that has no answer. */
  tell(agent: string, record: { type: string; [key: string]: unknown }): void {
    this.transport.send({ k: "hap", agent, rec: record as HapRecord });
  }

  onEvent(listener: (event: HubEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onHap(listener: (agent: string, record: HapRecord) => void): () => void {
    this.hapListeners.add(listener);
    return () => this.hapListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.transport.close();
  }
}
