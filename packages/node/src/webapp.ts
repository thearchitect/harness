// `harness web-app`'s server (plan 10.6): the app's web build and its /client endpoint on
// 127.0.0.1, for one window on this machine. The page proves itself with the token in its address's
// fragment (never sent in a request line); each of its connections is relayed to this user's node —
// the node running under its socket, or one inside this process — as a local client.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { decodeRecord, encodeRecord } from "#protocol/framing.ts";
import type { ClientFrame, NodeFrame, Transport } from "#protocol/node.ts";
import { serveStatic } from "./endpoints/static.ts";

export type WebApp = { url: string; server: Server; close(): void };

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== "string" || given.length !== token.length) {
    return false;
  } else {
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  }
}

export async function startWebApp(options: { staticDir: string; open: () => Promise<Transport> }): Promise<WebApp> {
  const token = randomBytes(24).toString("base64url");
  const server = createServer(serveStatic(options.staticDir));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://app");
    // only this machine's pages: the Host names the loopback address this server listens on
    if (url.pathname !== "/client" || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "")) {
      socket.destroy();
    } else {
      sockets.handleUpgrade(request, socket, head, (page) => {
        let node: Transport | undefined;
        const early: ClientFrame[] = [];
        page.once("message", (data) => {
          const decoded = decodeRecord(String(data));
          const hello = decoded.ok ? (decoded.record as ClientFrame) : undefined;
          if (hello?.k !== "hello" || !sameToken(hello.token, token)) {
            page.send(encodeRecord({ k: "refused", error: { code: "unauthorized", message: "this window's token does not match" } }));
            page.close();
          } else {
            void options
              .open()
              .then((transport) => {
                node = transport;
                transport.onFrame((frame: NodeFrame) => page.send(encodeRecord(frame)));
                transport.onClose(() => page.close());
                transport.send({ ...hello, token: undefined });
                for (const frame of early.splice(0)) {
                  transport.send(frame);
                }
              })
              .catch((error: unknown) => {
                page.send(encodeRecord({ k: "refused", error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } }));
                page.close();
              });
            page.on("message", (more) => {
              const frame = decodeRecord(String(more));
              if (!frame.ok) {
                // malformed: the node would refuse it too
              } else if (node === undefined) {
                early.push(frame.record as ClientFrame);
              } else {
                node.send(frame.record as ClientFrame);
              }
            });
          }
        });
        page.on("close", () => node?.close());
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    server,
    close: () => {
      sockets.close();
      server.close();
    },
  };
}
