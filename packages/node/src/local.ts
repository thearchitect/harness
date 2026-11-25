// The user's node on this machine, as a client process (a TUI, `harness web-app`) reaches it: the
// node under its socket (a service, or another window holding it), or a node inside this process.
//
// The first client finds no node and holds one: it runs it in its own process and listens on the
// socket for the user's other clients. When the holder exits, the others lose the node together and
// elect a new holder: each tries to create the lock file (`locks/node-<name>.lock`, with its PID);
// the one that does holds the node, the rest connect to its socket once it listens. A lock whose
// process is gone is left over from a crash and removed. A node that is a service (`harness node`)
// is never replaced: its clients wait for its supervisor to start it again.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import type { NodeHost, Transport } from "#protocol/node.ts";
import { listenUnix, socketAlive, socketPath } from "./endpoints/unix.ts";
import { inProcessTransport, unixTransport } from "./endpoints/transports.ts";
import { HarnessNode, type NodeConfig } from "./node.ts";

/** How long a client waits for the elected holder's socket before it gives up (the client retries). */
const ELECTION_MS = 10_000;

export type LocalNodeOptions = {
  home: string;
  name: string;
  harnessVersion: string;
  /** More of the held node's configuration (the test stand's agents). */
  node?: Partial<NodeConfig>;
};

/**
 * Why this client cannot use the local node: another harness version runs it (the operator closes
 * that window or restarts the service); undefined when the versions match.
 */
export function versionProblem(client: string, welcome: { node: string; harness: string; host: NodeHost; pid: number }): string | undefined {
  if (welcome.harness === client) {
    return undefined;
  } else {
    const holder = welcome.host === "client" ? `held by window PID ${welcome.pid}` : "a service";
    return `harness ${client}: node ${welcome.node} runs harness ${welcome.harness} (${holder}); close it or restart the service`;
  }
}

/**
 * What quitting a window asks first: nothing for a client of another holder or of a service, nor
 * for a holder whose node has no working agents and no other windows; otherwise what stops with it.
 */
export function quitQuestion(activity: { running: number; otherClients: number } | undefined): string | undefined {
  if (activity === undefined || (activity.running === 0 && activity.otherClients === 0)) {
    return undefined;
  } else {
    return `Quitting stops ${activity.running} running agents (${activity.otherClients} other windows use this node)`;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LocalNode {
  private readonly options: LocalNodeOptions;
  private readonly socket: string;
  private readonly lock: string;
  private held: { node: HarnessNode; server: Server } | undefined;
  /** The host of the node this process last connected to (a service is waited for, never replaced). */
  private lastHost: NodeHost | undefined;

  constructor(options: LocalNodeOptions) {
    this.options = options;
    this.socket = socketPath(options.home, options.name);
    this.lock = join(options.home, "locks", `node-${options.name}.lock`);
  }

  /** The node this process holds, if it does. */
  get node(): HarnessNode | undefined {
    return this.held?.node;
  }

  /** What a connection's welcome said of the node (its host). */
  observe(host: NodeHost): void {
    this.lastHost = host;
  }

  /**
   * A transport to the node: this process's own; the socket's; or, when nobody holds the node and
   * this process wins the lock, a node held here.
   */
  async transport(): Promise<Transport> {
    const deadline = Date.now() + ELECTION_MS;
    for (;;) {
      if (this.held !== undefined) {
        return inProcessTransport(this.held.node);
      } else if (await socketAlive(this.socket)) {
        return await unixTransport(this.socket);
      } else if (this.lastHost === "service") {
        throw new Error(`node ${this.options.name} (a service) is not listening on ${this.socket}: its supervisor starts it again`);
      } else if (this.acquire()) {
        await this.hold();
      } else if (Date.now() > deadline) {
        throw new Error(`node ${this.options.name}: another window holds its lock but does not listen on ${this.socket}`);
      } else {
        // another window is starting the node: its socket comes up shortly
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
      }
    }
  }

  /** Creates the lock file with this process's PID; a lock of a process that is gone is removed first. */
  private acquire(): boolean {
    mkdirSync(join(this.options.home, "locks"), { recursive: true, mode: 0o700 });
    try {
      const fd = openSync(this.lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      } else {
        const owner = Number.parseInt(readFileSync(this.lock, "utf8"), 10);
        if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) {
          return false;
        } else {
          rmSync(this.lock, { force: true });
          return this.acquire();
        }
      }
    }
  }

  private async hold(): Promise<void> {
    const node = new HarnessNode({
      name: this.options.name,
      dataDir: this.options.home,
      harnessVersion: this.options.harnessVersion,
      ...this.options.node,
      host: "client",
      restart: () => this.restart(),
    });
    try {
      this.held = { node, server: await listenUnix(node, this.socket) };
      this.lastHost = "client";
    } catch (error) {
      await node.close();
      rmSync(this.lock, { force: true });
      throw error;
    }
  }

  /** node_restart of a held node: its agents and processes stop, a new node starts here (the lock stays). */
  private async restart(): Promise<void> {
    const held = this.held;
    if (held !== undefined) {
      this.held = undefined;
      held.server.close();
      await held.node.close();
      await this.hold();
    } else {
      // not held here (closed meanwhile)
    }
  }

  /** Stops the node this process holds and gives its lock up (the user's other windows elect a holder). */
  async close(): Promise<void> {
    const held = this.held;
    if (held !== undefined) {
      this.held = undefined;
      held.server.close();
      await held.node.close();
      rmSync(this.lock, { force: true });
    } else {
      // a client of another holder or of a service
    }
  }
}
