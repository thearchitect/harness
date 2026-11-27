// A hub service's configuration (~/.harness/hub/config.json, or the file the NixOS module and the
// Fly image give with --config). Missing file: everything from the user's settings.

import { readFileSync } from "node:fs";
import type { NetworkSettings } from "#protocol/hub.ts";
import { layoutOf } from "#protocol/layout.ts";

export type HubFileConfig = {
  /**
   * The network access for the user's devices (on when given), instead of the user's setting:
   * `listen` behind a TLS proxy, `url` the address devices reach it at (pairing links), e.g.
   * https://my-harness.fly.dev.
   */
  network?: Partial<NetworkSettings>;
  /** Minutes without clients and without working agents after which the service exits (Fly's machine then stops). */
  idleExit?: number;
  /** A shared server (the Fly image): agents get the `server` skill (no root, installing into ~, credentials). */
  server?: boolean;
};

/** `path`: an explicit file (the NixOS module's); otherwise ~/.harness/hub/config.json. */
export function readHubConfig(home: string, path?: string): HubFileConfig {
  const file = path ?? layoutOf(home).hubConfig;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HubFileConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && path === undefined) {
      return {};
    } else {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
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
