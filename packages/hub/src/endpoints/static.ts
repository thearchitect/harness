// The app's web build over HTTP: files of its directory, and index.html for any other path (the app
// reads its own address). Hubs and `harness web-app` serve it.

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

export function serveStatic(root: string): (request: IncomingMessage, response: ServerResponse) => void {
  const index = join(root, "index.html");
  return (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
    } else {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://app").pathname);
      const file = normalize(join(root, path));
      const inside = file === root || file.startsWith(`${root}${sep}`);
      const target = inside && existsSync(file) && statSync(file).isFile() ? file : index;
      // the bundle's names carry their hash: cached for good; index.html never
      const immutable = target !== index && path.includes("/_expo/");
      response.writeHead(200, {
        "content-type": TYPES[extname(target)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        createReadStream(target).pipe(response);
      }
    }
  };
}

/** The app's web build: HARNESS_APP_WEB (the bundle's launcher sets it to its build). */
export function appWebDir(): string | undefined {
  const dir = process.env.HARNESS_APP_WEB;
  return dir !== undefined && dir !== "" && existsSync(join(dir, "index.html")) ? dir : undefined;
}
