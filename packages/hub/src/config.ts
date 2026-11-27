// A hub's configuration (~/.harness/nodes/<name>.json, written by hand or by the NixOS module):
// its network access. Missing file: the unix socket only.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type HubFileConfig = {
  /**
   * Network access for the user's devices besides the unix socket; `url`: the address devices
   * reach it at (pairing links), e.g. https://my-harness.fly.dev.
   */
  hub?: { listen: string; url?: string };
  /** A shared server (the Fly image): agents get the `server` skill (no root, installing into ~, credentials). */
  server?: boolean;
};

/** `path`: an explicit file (the NixOS module's); otherwise ~/.harness/nodes/<name>.json. */
export function readHubConfig(home: string, name: string, path?: string): HubFileConfig {
  try {
    return JSON.parse(readFileSync(path ?? join(home, "nodes", `${name}.json`), "utf8")) as HubFileConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && path === undefined) {
      return {};
    } else {
      throw new Error(`nodes/${name}.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** "host:port" or ":port" (all interfaces) or "port" (loopback). */
export function parseListen(listen: string): { host: string; port: number } {
  const match = /^(?:(.*):)?(\d+)$/.exec(listen);
  if (match === null) {
    throw new Error(`listen ${JSON.stringify(listen)}: use host:port`);
  } else {
    const host = match[1] === undefined ? "127.0.0.1" : match[1] === "" ? "0.0.0.0" : match[1];
    return { host, port: Number(match[2]) };
  }
}
