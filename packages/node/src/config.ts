// A node's configuration (~/.harness/nodes/<name>.json, written by hand or by the NixOS module):
// the hub users allowed on it and the hubs it links to. Missing file: no users, no hubs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type NodeFileConfig = {
  /** Hub users allowed on this node through its hubs. */
  users?: string[];
  /** Hubs this node connects out to. */
  hubs?: { url: string; key?: string; keyFile?: string }[];
  /** Roles besides the node: a hub listening for devices and nodes. */
  hub?: { listen: string };
};

export function readNodeConfig(home: string, name: string): NodeFileConfig {
  try {
    return JSON.parse(readFileSync(join(home, "nodes", `${name}.json`), "utf8")) as NodeFileConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    } else {
      throw new Error(`nodes/${name}.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function hubKey(hub: { url: string; key?: string; keyFile?: string }): string {
  if (hub.key !== undefined) {
    return hub.key;
  } else if (hub.keyFile !== undefined) {
    return readFileSync(hub.keyFile, "utf8").trim();
  } else {
    throw new Error(`hub ${hub.url}: no key or keyFile`);
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
