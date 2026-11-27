// The hub's network endpoint, behind a TLS proxy (Fly, tailscale serve, Caddy): HTTP with
//   /ws     the protocol over a WebSocket, for paired devices: the device token in the hello, or a
//           browser's cookie (sent by the browser itself, from the page's own origin only);
//   /pair   POST { code, name?, cookie? }: a device exchanges its one-time code for its token (a
//           browser asks for it as an HttpOnly cookie and never sees it);
//   /unpair POST: a browser forgets its pairing (the device is revoked, the cookie cleared);
//   else    the app's web build, when given.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { decodeRecord, encodeRecord } from "#protocol/framing.ts";
import { HarnessError, toProtocolError } from "#protocol/errors.ts";
import type { ClientFrame } from "#protocol/hub.ts";
import type { HubAuth } from "../auth.ts";
import type { Connection, Hub } from "../hub.ts";

export type WsEndpointOptions = {
  host: string;
  port: number;
  /** Only a proxy reaches the port: the client's address is the one it forwards. */
  proxy: boolean;
  /** Other HTTP requests (the web app); 404 without it. */
  http?: (request: IncomingMessage, response: ServerResponse) => void;
};

/** The cookie a paired browser keeps its device token in. */
export const DEVICE_COOKIE = "harness_device";

const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** The client's address: the socket's, or behind the proxy the one it forwards. */
function addressOf(request: IncomingMessage, proxy: boolean): string {
  const forwarded = request.headers["fly-client-ip"] ?? request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return proxy && first !== undefined && first !== "" ? first : (request.socket.remoteAddress ?? "unknown");
}

function cookieOf(request: IncomingMessage): string | undefined {
  const pair = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEVICE_COOKIE}=`));
  return pair?.slice(DEVICE_COOKIE.length + 1);
}

/** Whether a browser's request comes from the hub's own page (a cookie must not serve another site's). */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  return origin !== undefined && host !== undefined && new URL(origin).host === (Array.isArray(host) ? host[0] : host);
}

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

async function acceptClient(hub: Hub, auth: HubAuth, socket: WebSocket, address: string, cookie: string | undefined): Promise<void> {
  const hello = (await firstFrame(socket)) as ClientFrame;
  const token = hello.k === "hello" ? (hello.token ?? cookie) : undefined;
  if (hello.k !== "hello" || token === undefined) {
    refuse(socket, new HarnessError("unauthorized", "the first frame must be hello, from a paired device"));
  } else {
    let device: string;
    try {
      device = auth.deviceOfToken(token, hub.clock.now(), address);
    } catch (error) {
      hub.telemetry.log({ event: "device_refused", address, reason: error instanceof Error ? error.message : String(error) });
      refuse(socket, error);
      return;
    }
    const connection: Connection = {
      id: randomUUID(),
      device,
      send: (frame) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(encodeRecord(frame));
        } else {
          // the device is gone
        }
      },
      close: () => socket.close(),
    };
    const receive = hub.accept(connection);
    socket.on("message", (data) => {
      const decoded = decodeRecord(String(data));
      if (decoded.ok) {
        receive(decoded.record as ClientFrame);
      } else {
        connection.send({ k: "res", id: "", ok: false, error: { code: "invalid_record", message: decoded.error } });
      }
    });
    socket.on("close", () => hub.disconnect(connection));
    receive(hello);
  }
}

const BODY_LIMIT = 1024;

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += String(chunk);
      if (body.length > BODY_LIMIT) {
        request.destroy();
        reject(new HarnessError("invalid_record", "the request is too large"));
      } else {
        // more of it
      }
    });
    request.on("end", () => {
      try {
        const value = JSON.parse(body === "" ? "{}" : body) as unknown;
        resolve(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
      } catch {
        reject(new HarnessError("invalid_record", "the body must be JSON"));
      }
    });
  });
}

function reply(response: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));
}

function replyError(response: ServerResponse, error: unknown): void {
  const known = error instanceof HarnessError;
  reply(response, known && error.code === "unauthorized" ? 401 : 400, { error: toProtocolError(error) });
}

/** POST /pair { code, name?, cookie? } → { device, token } (a browser: { device } and the cookie). */
async function pair(hub: Hub, auth: HubAuth, proxy: boolean, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const address = addressOf(request, proxy);
  if (request.method !== "POST") {
    reply(response, 405, { error: { code: "invalid_record", message: "POST { code, name? }" } });
  } else {
    try {
      const { code, name, cookie } = await readJson(request);
      if (typeof code !== "string") {
        throw new HarnessError("invalid_record", "POST { code, name? }");
      } else {
        const paired = auth.redeemPairing(code, hub.clock.now(), address, typeof name === "string" ? name : undefined);
        hub.telemetry.log({ event: "paired", pairing: paired.pairing, device: paired.device, address });
        hub.devicesChanged();
        if (cookie === true) {
          reply(response, 200, { device: paired.device }, { "set-cookie": `${DEVICE_COOKIE}=${paired.token}; ${COOKIE_ATTRIBUTES}; Max-Age=${400 * 24 * 3600}` });
        } else {
          reply(response, 200, { device: paired.device, token: paired.token });
        }
      }
    } catch (error) {
      hub.telemetry.log({ event: "pairing_failed", address, reason: error instanceof Error ? error.message : String(error) });
      replyError(response, error);
    }
  }
}

/** POST /unpair: the browser's device is revoked and its cookie cleared. */
function unpair(hub: Hub, auth: HubAuth, proxy: boolean, request: IncomingMessage, response: ServerResponse): void {
  const token = cookieOf(request);
  const clear = { "set-cookie": `${DEVICE_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0` };
  if (request.method !== "POST" || !sameOrigin(request)) {
    reply(response, 405, { error: { code: "invalid_record", message: "POST from the hub's own page" } });
  } else if (token === undefined) {
    reply(response, 200, {}, clear);
  } else {
    try {
      const device = auth.deviceOfToken(token, hub.clock.now(), addressOf(request, proxy));
      hub.revokeDevice(device);
      reply(response, 200, {}, clear);
    } catch (error) {
      reply(response, 200, { error: toProtocolError(error) }, clear);
    }
  }
}

/** A running endpoint: where it listens; closing it ends its devices' connections too. */
export type NetworkEndpoint = { address(): AddressInfo; close(): Promise<void> };

export async function listenWs(hub: Hub, auth: HubAuth, options: WsEndpointOptions): Promise<NetworkEndpoint> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://hub").pathname;
    if (path === "/pair") {
      void pair(hub, auth, options.proxy, request, response);
    } else if (path === "/unpair") {
      unpair(hub, auth, options.proxy, request, response);
    } else if (options.http !== undefined) {
      options.http(request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://hub").pathname;
    if (path === "/ws") {
      // a browser's cookie counts only from the hub's own page
      const cookie = sameOrigin(request) ? cookieOf(request) : undefined;
      const address = addressOf(request, options.proxy);
      sockets.handleUpgrade(request, socket, head, (ws) => {
        acceptClient(hub, auth, ws, address, cookie).catch(() => ws.close());
      });
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return {
    address: () => server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) {
          client.terminate();
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
