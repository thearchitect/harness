// The hub's network endpoint: HTTP with WebSockets on it — `/client` for users' devices (the hello
// carries a device token), `/uplink` for nodes (the hello carries the node's key). TLS comes from
// the reverse proxy in front (Fly, a local proxy). Other HTTP paths are served by `http` (the web
// app), when given.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { decodeRecord, encodeRecord } from "#protocol/framing.ts";
import { toProtocolError } from "#protocol/errors.ts";
import type { ClientFrame, NodeToHubFrame } from "#protocol/node.ts";
import { compatibleProtocol, PROTOCOL_VERSION } from "#protocol/version.ts";
import type { Hub, UplinkPeer } from "../hub.ts";
import type { Connection, HarnessNode } from "../node.ts";

export type WsEndpointOptions = {
  host: string;
  port: number;
  /** Other HTTP requests (the web app); 404 without it. */
  http?: (request: IncomingMessage, response: ServerResponse) => void;
};

function firstFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      const decoded = decodeRecord(String(data));
      if (decoded.ok) {
        resolve(decoded.record);
      } else {
        reject(new Error(decoded.error));
      }
    });
    socket.once("close", () => reject(new Error("closed before hello")));
  });
}

function refuse(socket: WebSocket, error: unknown): void {
  socket.send(encodeRecord({ k: "refused", error: toProtocolError(error) }));
  socket.close();
}

async function acceptClient(node: HarnessNode, hub: Hub, socket: WebSocket): Promise<void> {
  const hello = (await firstFrame(socket)) as ClientFrame;
  if (hello.k !== "hello" || typeof hello.token !== "string") {
    refuse(socket, new Error("the first frame must be hello with a device token"));
  } else {
    let user: string;
    try {
      user = hub.auth.userOfToken(hello.token);
    } catch (error) {
      refuse(socket, error);
      return;
    }
    const connection: Connection = {
      id: randomUUID(),
      user,
      trusted: false,
      send: (frame) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(encodeRecord(frame));
        } else {
          // the device is gone
        }
      },
      close: () => socket.close(),
    };
    const receive = node.accept(connection);
    hub.track(connection);
    socket.on("message", (data) => {
      const decoded = decodeRecord(String(data));
      if (decoded.ok) {
        receive(decoded.record as ClientFrame);
      } else {
        connection.send({ k: "res", id: "", ok: false, error: { code: "invalid_record", message: decoded.error } });
      }
    });
    socket.on("close", () => node.disconnect(connection));
    receive(hello);
  }
}

async function acceptUplink(hub: Hub, socket: WebSocket): Promise<void> {
  const hello = (await firstFrame(socket)) as NodeToHubFrame;
  if (hello.k !== "hello" || typeof hello.token !== "string") {
    refuse(socket, new Error("the first frame must be hello with the node key"));
  } else if (!compatibleProtocol(hello.protocol)) {
    socket.send(encodeRecord({ k: "refused", error: { code: "version_mismatch", message: `protocol ${hello.protocol} is not ${PROTOCOL_VERSION}` } }));
    socket.close();
  } else {
    let name: string;
    try {
      name = hub.auth.nodeOfKey(hello.token).name;
    } catch (error) {
      refuse(socket, error);
      return;
    }
    const peer: UplinkPeer = {
      name,
      send: (frame) => socket.send(encodeRecord(frame)),
      close: () => socket.close(),
    };
    socket.send(encodeRecord({ k: "welcome", protocol: PROTOCOL_VERSION, harness: "", node: name, user: "" }));
    hub.attachUplink(peer);
    socket.on("message", (data) => {
      const decoded = decodeRecord(String(data));
      const frame = decoded.ok ? (decoded.record as NodeToHubFrame) : undefined;
      if (frame?.k === "route") {
        hub.fromNode(name, frame.conn, frame.frame);
      } else {
        // nothing else travels from a node after its hello
      }
    });
    socket.on("close", () => hub.detachUplink(peer));
  }
}

export async function listenWs(node: HarnessNode, hub: Hub, options: WsEndpointOptions): Promise<Server> {
  const server = createServer((request, response) => {
    if (options.http !== undefined) {
      options.http(request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://hub").pathname;
    if (path === "/client" || path === "/uplink") {
      sockets.handleUpgrade(request, socket, head, (ws) => {
        const accepting = path === "/client" ? acceptClient(node, hub, ws) : acceptUplink(hub, ws);
        accepting.catch(() => ws.close());
      });
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return server;
}
