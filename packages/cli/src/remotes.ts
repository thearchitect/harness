// The client's remote hubs and nodes (~/.harness/remotes.json, 0600): a name, the WebSocket base
// and the device token. `harness remote add|remove|list` edits them; the TUI connects to each.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Remote = { name: string; url: string; token: string };

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
