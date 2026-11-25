/**
 * The gateway's HTTP endpoint:
 *
 * - POST <webhook path>: Telegram updates, authenticated by the
 *   X-Telegram-Bot-Api-Secret-Token header. Every accepted update is answered
 *   200 at once and handled asynchronously (Telegram would redeliver an update
 *   whose request took too long).
 * - /app/…: the Mini App (app/server.ts), once the gateway is ready; 503
 *   before that, so the Mini App retries.
 *
 * Everything else gets 401/404/405.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Update } from "grammy/types";
import type { Telemetry } from "./telemetry.ts";

const BODY_LIMIT = 1024 * 1024;

export type AppHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => void;

export type ServerOptions = {
  port: number;
  webhookPath: string;
  webhookSecret: string;
  onUpdate(update: Update): void;
  /** The Mini App, when the gateway is ready. */
  app(): AppHandler | undefined;
  t: Telemetry;
};

/** Reads a request body of at most BODY_LIMIT bytes; undefined when it is larger (413 sent). */
export function readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        response.writeHead(413).end();
        request.destroy();
        resolve(undefined);
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => resolve(undefined));
  });
}

export function startServer(options: ServerOptions): Promise<Server> {
  const expected = Buffer.from(options.webhookSecret);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      const app = options.app();
      if (app !== undefined) {
        app(request, response, url);
      } else {
        response.writeHead(503, { "Retry-After": "1" }).end("starting");
      }
    } else if (url.pathname !== options.webhookPath) {
      response.writeHead(404).end();
    } else if (request.method !== "POST") {
      response.writeHead(405).end();
    } else {
      const header = request.headers["x-telegram-bot-api-secret-token"];
      const given = Buffer.from(typeof header === "string" ? header : "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        options.t.warn("webhook.rejected", { remote: request.headers["fly-client-ip"] ?? request.socket.remoteAddress });
        response.writeHead(401).end();
      } else {
        void readBody(request, response).then((body) => {
          if (body === undefined) {
            return; // too large: answered already
          }
          let update: Update;
          try {
            update = JSON.parse(body.toString("utf8")) as Update;
          } catch {
            response.writeHead(400).end();
            return;
          }
          response.writeHead(200).end();
          options.onUpdate(update);
        });
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
