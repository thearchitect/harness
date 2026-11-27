// The client's remote hubs (~/.harness/remotes.json, 0600), by name: over the network (the hub's
// address and this device's token) or over SSH (`[user@]host[:port]` and the harness there).
// `harness connect` adds them, `harness remote list|remove` shows and removes them; the TUI
// connects to each.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Remote = { name: string; url: string; token: string } | { name: string; ssh: string; command?: string };

function path(home: string): string {
  return join(home, "remotes.json");
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
  const temp = `${path(home)}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(remotes, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path(home));
}

/** Adds a remote, replacing one of the same name. */
export function addRemote(home: string, remote: Remote): void {
  writeRemotes(home, [...readRemotes(home).filter((known) => known.name !== remote.name), remote]);
}
