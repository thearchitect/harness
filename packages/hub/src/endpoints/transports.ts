// Client transports that need Node: a unix socket to a hub, a hub on another machine over SSH, and
// a hub in the same process.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import type { ClientFrame, HubFrame, Transport } from "#protocol/hub.ts";
import type { Hub } from "../hub.ts";

export function unixTransport(path: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const frameListeners = new Set<(frame: HubFrame) => void>();
    const closeListeners = new Set<(reason: string) => void>();
    const decoder = new LineDecoder();
    let closeReason = "the hub closed the connection";
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const decoded = decodeRecord(line);
        if (decoded.ok) {
          for (const listener of frameListeners) {
            listener(decoded.record as HubFrame);
          }
        } else {
          closeReason = `malformed frame from the hub: ${decoded.error}`;
          socket.destroy();
        }
      }
    });
    socket.once("connect", () =>
      resolve({
        send: (frame: ClientFrame) => {
          socket.write(encodeRecord(frame));
        },
        onFrame: (listener) => frameListeners.add(listener),
        onClose: (listener) => closeListeners.add(listener),
        close: () => socket.end(),
      }),
    );
    socket.once("error", (error) => {
      closeReason = error.message;
      reject(error);
    });
    socket.on("close", () => {
      for (const listener of closeListeners) {
        listener(closeReason);
      }
    });
  });
}

/** A hub on another machine, reached over SSH: `ssh` is `[user@]host[:port]`, `command` the harness there. */
export type SshTarget = { ssh: string; command?: string };

/** The ssh arguments that run `harness hub attach` on the target; `interactive`: ssh may ask (a host key, a passphrase). */
export function sshArguments(target: SshTarget, interactive: boolean): string[] {
  const match = /^(.*?)(?::(\d+))?$/.exec(target.ssh);
  const host = match?.[1] ?? target.ssh;
  const port = match?.[2];
  return [
    "-T",
    ...(interactive ? [] : ["-o", "BatchMode=yes"]),
    "-o",
    "ServerAliveInterval=15",
    ...(port !== undefined ? ["-p", port] : []),
    host,
    `${target.command ?? "harness"} hub attach`,
  ];
}

/**
 * The hub of another machine over SSH (`harness hub attach` there joins ssh's stdio to its socket).
 * ssh's own complaints (a refused key, an unknown host, no hub running) become the close reason.
 * `HARNESS_SSH` names another ssh (tests).
 */
export function sshTransport(target: SshTarget, interactive = false): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HARNESS_SSH ?? "ssh", sshArguments(target, interactive), { stdio: ["pipe", "pipe", "pipe"] });
    const frameListeners = new Set<(frame: HubFrame) => void>();
    const closeListeners = new Set<(reason: string) => void>();
    const decoder = new LineDecoder();
    let stderr = "";
    let opened = false;
    const reason = (code: number | null): string => stderr.trim().split("\n").at(-1) ?? `ssh ${target.ssh} exited (${String(code)})`;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const decoded = decodeRecord(line);
        if (decoded.ok) {
          for (const listener of frameListeners) {
            listener(decoded.record as HubFrame);
          }
        } else {
          stderr = `malformed frame from ${target.ssh}: ${decoded.error}`;
          child.kill();
        }
      }
    });
    child.once("spawn", () => {
      opened = true;
      resolve({
        send: (frame: ClientFrame) => {
          child.stdin.write(encodeRecord(frame));
        },
        onFrame: (listener) => frameListeners.add(listener),
        onClose: (listener) => closeListeners.add(listener),
        close: () => child.kill(),
      });
    });
    child.once("error", (error) => (opened ? undefined : reject(error)));
    child.stdin.on("error", () => undefined); // a broken pipe: the close below says why
    child.once("close", (code) => {
      const why = stderr.trim() !== "" ? reason(code) : `ssh ${target.ssh} exited (${String(code)})`;
      for (const listener of closeListeners) {
        listener(why);
      }
    });
  });
}

/** A transport to a hub living in this process: frames are passed as objects, asynchronously. */
export function inProcessTransport(node: Hub): Transport {
  const frameListeners = new Set<(frame: HubFrame) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  let open = true;
  const connection = {
    id: randomUUID(),
    inProcess: true,
    send(frame: HubFrame) {
      // a copy, as a wire would make: neither side shares mutable objects with the other
      const copy = JSON.parse(JSON.stringify(frame)) as HubFrame;
      queueMicrotask(() => {
        for (const listener of frameListeners) {
          listener(copy);
        }
      });
    },
    close() {
      if (open) {
        open = false;
        node.disconnect(connection);
        for (const listener of closeListeners) {
          listener("closed");
        }
      } else {
        // closed already
      }
    },
  };
  const receive = node.accept(connection);
  return {
    send: (frame) => {
      const copy = JSON.parse(JSON.stringify(frame)) as ClientFrame;
      queueMicrotask(() => receive(copy));
    },
    onFrame: (listener) => frameListeners.add(listener),
    onClose: (listener) => closeListeners.add(listener),
    close: () => connection.close(),
  };
}
