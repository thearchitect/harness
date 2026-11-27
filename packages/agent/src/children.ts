// The agent as a client of its hub, for its subagents: frames of a HubConnection travel inside
// `harness_hub` records of the agent's own HAP stream. A child is started with agent_start
// { subagent } (the hub makes this agent its parent and sets the depth) and followed in full.

import { HubConnection } from "#client/connection.ts";
import type { HubFrame, Transport } from "#protocol/hub.ts";
import type { ChildAgent, ChildAgents, ChildLaunch, ChildRecord } from "#extension/host.ts";

export class HubChildren implements ChildAgents {
  private readonly write: (frame: unknown) => void;
  private readonly frameListeners = new Set<(frame: HubFrame) => void>();
  private connection: Promise<HubConnection> | undefined;
  /** Frames held until the hub knows this agent (it reads nothing before harness_hello). */
  private held: unknown[] | undefined = [];

  constructor(write: (frame: unknown) => void) {
    this.write = write;
  }

  /** The agent said hello: frames go out from now on. */
  ready(): void {
    const held = this.held ?? [];
    this.held = undefined;
    for (const frame of held) {
      this.write(frame);
    }
  }

  private send(frame: unknown): void {
    if (this.held !== undefined) {
      this.held.push(frame);
    } else {
      this.write(frame);
    }
  }

  /** A frame the hub sent to this agent's connection. */
  receive(frame: unknown): void {
    for (const listener of this.frameListeners) {
      listener(frame as HubFrame);
    }
  }

  private connect(): Promise<HubConnection> {
    this.connection ??= HubConnection.open(this.transport(), "agent");
    return this.connection;
  }

  private transport(): Transport {
    return {
      send: (frame) => this.send(frame),
      onFrame: (listener) => {
        this.frameListeners.add(listener);
        return () => this.frameListeners.delete(listener);
      },
      onClose: () => () => undefined, // the connection lives as long as this agent
      close: () => undefined,
    };
  }

  async start(launch: ChildLaunch): Promise<ChildAgent> {
    const connection = await this.connect();
    const { agent } = await connection.request("agent_start", {
      cwd: launch.cwd,
      sessionFile: launch.sessionFile,
      background: launch.background,
      subagent: { ...launch.subagent, depth: 0 },
    });
    const listeners = new Set<(record: ChildRecord) => void>();
    const off = connection.onHap((agentId, record) => {
      if (agentId === agent.id) {
        for (const listener of listeners) {
          listener(record as ChildRecord);
        }
      } else {
        // another child's record
      }
    });
    await connection.request("agent_attach", { agent: agent.id, level: "full" });
    return {
      agentId: agent.id,
      sessionId: agent.sessionId,
      sessionFile: agent.sessionFile,
      running: agent.summary.status === "running" || agent.summary.status === "waiting",
      onRecord: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      call: (record) => connection.call(agent.id, record),
      detach: async () => {
        off();
        await connection.request("agent_detach", { agent: agent.id }).catch(() => undefined);
      },
      close: async () => {
        off();
        await connection.request("agent_close", { agent: agent.id }).catch(() => undefined);
      },
    };
  }
}
