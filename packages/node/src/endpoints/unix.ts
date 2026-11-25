// The node's local endpoint: a unix socket in ~/.harness/sockets (a directory only the user can
// enter, which is the whole authorization: whoever reaches the socket is the node's user).

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import type { ClientFrame, NodeFrame } from "#protocol/node.ts";
import type { Connection, HarnessNode } from "../node.ts";

/** Longest unix socket path the kernel takes (sun_path, with its terminator). */
const MAX_SOCKET_PATH = process.platform === "darwin" ? 103 : 107;

export function socketPath(dataDir: string, name: string): string {
  return join(dataDir, "sockets", `${name}.sock`);
}

function socketConnection(socket: Socket): Connection {
  return {
    id: randomUUID(),
    send(frame: NodeFrame) {
      if (!socket.destroyed) {
        socket.write(encodeRecord(frame));
      } else {
        // the client is gone
      }
    },
    close() {
      socket.end();
    },
  };
}

/** Whether a node answers on the socket (a leftover file of a dead node does not). */
export function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(path)) {
      resolve(false);
    } else {
      const probe = createConnection(path);
      probe.once("connect", () => {
        probe.end();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    }
  });
}

export async function listenUnix(node: HarnessNode, path: string): Promise<Server> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new Error(`the socket path ${path} is ${Buffer.byteLength(path)} bytes; unix sockets take at most ${MAX_SOCKET_PATH}: set HARNESS_HOME to a shorter directory`);
  } else if (await socketAlive(path)) {
    throw new Error(`a node already listens on ${path}`);
  } else {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    rmSync(path, { force: true });
    const server = createServer((socket) => {
      const connection = socketConnection(socket);
      const receive = node.accept(connection);
      const decoder = new LineDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          const decoded = decodeRecord(line);
          if (decoded.ok) {
            receive(decoded.record as ClientFrame);
          } else {
            connection.send({ k: "res", id: "", ok: false, error: { code: "invalid_record", message: decoded.error } });
          }
        }
      });
      socket.on("close", () => node.disconnect(connection));
      socket.on("error", () => node.disconnect(connection));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    return server;
  }
}
