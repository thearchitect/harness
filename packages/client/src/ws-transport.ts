// A WebSocket to a hub, for any client: the browser's WebSocket, or node's global one. The device
// token goes in the hello (NodeConnection.open), not in the URL.

import { decodeRecord, encodeRecord } from "#protocol/framing.ts";
import type { ClientFrame, NodeFrame, Transport } from "#protocol/node.ts";

/** `url`: the hub's base, ws(s)://host[:port]; the client endpoint is its /client. */
export function wsTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace(/\/$/, "")}/client`);
    const frameListeners = new Set<(frame: NodeFrame) => void>();
    const closeListeners = new Set<(reason: string) => void>();
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send: (frame: ClientFrame) => socket.send(encodeRecord(frame)),
        onFrame: (listener) => frameListeners.add(listener),
        onClose: (listener) => closeListeners.add(listener),
        close: () => socket.close(),
      });
    });
    socket.addEventListener("message", (event) => {
      const decoded = decodeRecord(String(event.data));
      if (decoded.ok) {
        for (const listener of frameListeners) {
          listener(decoded.record as NodeFrame);
        }
      } else {
        // a malformed frame: the hub answers with errors as frames, never like this
      }
    });
    socket.addEventListener("close", (event) => {
      if (!opened) {
        reject(new Error(`cannot reach ${url}: ${event.reason !== "" ? event.reason : `closed (${event.code})`}`));
      } else {
        for (const listener of closeListeners) {
          listener(event.reason !== "" ? event.reason : "the hub closed the connection");
        }
      }
    });
  });
}
