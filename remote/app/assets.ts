/**
 * The Mini App's static files, prepared once at start: every asset gets a
 * content hash in its URL (`/app/app.<hash>.js`) and is served as immutable;
 * index.html refers to those URLs and is revalidated on every open by its
 * ETag (the build hash), so an open after a deploy gets the new build at
 * once and every other open costs a 304. Bodies are kept compressed (brotli,
 * gzip) in memory.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";

type Prepared = { type: string; identity: Buffer; br: Buffer; gzip: Buffer };

/**
 * Scripts: our own and telegram-web-app.js. Alpine evaluates its directive
 * expressions with `new Function`, hence 'unsafe-eval'; every expression is
 * part of index.html, none comes from data.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org 'unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type AssetFiles = { index: string; assets: Record<string, string> };

export class Assets {
  readonly build: string;
  private readonly index: Prepared;
  private readonly byPath = new Map<string, Prepared>();

  /** `files.assets`: public name (`app.js`) → file; index.html refers to them as `{{app.js}}`. */
  constructor(files: AssetFiles) {
    const urls = new Map<string, string>();
    const hashes: string[] = [];
    for (const [name, file] of Object.entries(files.assets)) {
      const content = readFileSync(file);
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const dot = name.lastIndexOf(".");
      const url = `/app/${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
      urls.set(name, url);
      hashes.push(hash);
      this.byPath.set(url, prepare(typeOf(name), content));
    }
    const html = readFileSync(files.index, "utf8").replace(/\{\{([\w.-]+)\}\}/g, (whole, name: string) => {
      const url = urls.get(name);
      if (url === undefined) throw new Error(`index.html refers to an unknown asset ${whole}`);
      return url;
    });
    this.build = createHash("sha256").update(html).update(hashes.join()).digest("hex").slice(0, 16);
    this.index = prepare("text/html; charset=utf-8", Buffer.from(html));
  }

  /** Serves `/app/` and the hashed assets; false when the path is not one of them. */
  serve(request: IncomingMessage, response: ServerResponse, path: string): boolean {
    if (path === "/app" || path === "/app/" || path === "/app/index.html") {
      const etag = `"${this.build}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" }).end();
      } else {
        this.send(request, response, this.index, { ETag: etag, "Cache-Control": "no-cache", "Content-Security-Policy": CSP });
      }
      return true;
    } else {
      const asset = this.byPath.get(path);
      if (asset === undefined) {
        return false;
      } else {
        this.send(request, response, asset, { "Cache-Control": "public, max-age=31536000, immutable" });
        return true;
      }
    }
  }

  private send(request: IncomingMessage, response: ServerResponse, body: Prepared, headers: Record<string, string>): void {
    const accept = String(request.headers["accept-encoding"] ?? "");
    const [encoding, content] = /\bbr\b/.test(accept) ? ["br", body.br] : /\bgzip\b/.test(accept) ? ["gzip", body.gzip] : [undefined, body.identity];
    response.writeHead(200, {
      ...headers,
      "Content-Type": body.type,
      "Content-Length": String(content.length),
      Vary: "Accept-Encoding",
      "X-Content-Type-Options": "nosniff",
      ...(encoding !== undefined ? { "Content-Encoding": encoding } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : content);
  }
}

function prepare(type: string, identity: Buffer): Prepared {
  return { type, identity, br: brotliCompressSync(identity), gzip: gzipSync(identity) };
}

function typeOf(name: string): string {
  if (name.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  } else if (name.endsWith(".css")) {
    return "text/css; charset=utf-8";
  } else {
    throw new Error(`unknown asset type: ${name}`);
  }
}
