// The client's remote hubs (~/.harness/client/remotes.json, 0600), by name: over the network (the hub's
// address and this device's token) or over SSH (`[user@]host[:port]` and the harness there).
// `harness connect` adds them, `harness remote list|remove` shows and removes them; the TUI
// connects to each.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { layoutOf } from "#protocol/layout.ts";

export type Remote = { name: string; url: string; token: string } | { name: string; ssh: string; command?: string };

function path(home: string): string {
  return layoutOf(home).remotes;
}

export function readRemotes(home: string): Remote[] {
  try {
    return JSON.parse(readFileSync(path(home), "utf8")) as Remote[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    } else {
      throw error;
    }
  }
}

export function writeRemotes(home: string, remotes: Remote[]): void {
  mkdirSync(dirname(path(home)), { recursive: true, mode: 0o700 });
  const temp = `${path(home)}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(remotes, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path(home));
}

/** Adds a remote, replacing one of the same name. */
export function addRemote(home: string, remote: Remote): void {
  writeRemotes(home, [...readRemotes(home).filter((known) => known.name !== remote.name), remote]);
}
