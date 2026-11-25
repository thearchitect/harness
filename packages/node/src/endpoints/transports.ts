// Client transports that need Node: a unix socket to a node, and a node in the same process.

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import type { ClientFrame, NodeFrame, Transport } from "#protocol/node.ts";
import type { HarnessNode } from "../node.ts";

export function unixTransport(path: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const frameListeners = new Set<(frame: NodeFrame) => void>();
    const closeListeners = new Set<(reason: string) => void>();
    const decoder = new LineDecoder();
    let closeReason = "the node closed the connection";
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const decoded = decodeRecord(line);
        if (decoded.ok) {
          for (const listener of frameListeners) {
            listener(decoded.record as NodeFrame);
          }
        } else {
          closeReason = `malformed frame from the node: ${decoded.error}`;
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

/** A transport to a node living in this process: frames are passed as objects, asynchronously. */
export function inProcessTransport(node: HarnessNode): Transport {
  const frameListeners = new Set<(frame: NodeFrame) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  let open = true;
  const connection = {
    id: randomUUID(),
    send(frame: NodeFrame) {
      // a copy, as a wire would make: neither side shares mutable objects with the other
      const copy = JSON.parse(JSON.stringify(frame)) as NodeFrame;
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
