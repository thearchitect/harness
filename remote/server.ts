/**
 * The webhook endpoint: one route, POST <path>, authenticated by Telegram's
 * X-Telegram-Bot-Api-Secret-Token header. Every accepted update is answered
 * 200 at once and handled asynchronously (Telegram would redeliver an update
 * whose request took too long); everything else gets 401/404/405.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Update } from "grammy/types";

const BODY_LIMIT = 1024 * 1024;

export type WebhookOptions = {
  port: number;
  path: string;
  secret: string;
  onUpdate(update: Update): void;
  log(line: string): void;
};

export function startWebhookServer(options: WebhookOptions): Promise<Server> {
  const expected = Buffer.from(options.secret);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const header = request.headers["x-telegram-bot-api-secret-token"];
    const given = Buffer.from(typeof header === "string" ? header : "");
    if (url.pathname !== options.path) {
      response.writeHead(404).end();
    } else if (request.method !== "POST") {
      response.writeHead(405).end();
    } else if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      options.log(`webhook: rejected a request without the secret from ${request.socket.remoteAddress ?? "?"}`);
      response.writeHead(401).end();
    } else {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          response.writeHead(413).end();
          request.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      request.on("end", () => {
        let update: Update;
        try {
          update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Update;
        } catch {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200).end();
        options.onUpdate(update);
      });
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
