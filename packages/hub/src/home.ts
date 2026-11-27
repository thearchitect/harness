// The user's harness directory: $HARNESS_HOME, else ~/.harness, in its layout (protocol/layout.ts).
// Created on first use with a `.gitignore` that ignores everything (it holds credentials and
// sessions) and private directories; a home of the flat layout of earlier versions is moved first.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { layoutOf } from "#protocol/layout.ts";
import { migrateHome, needsMigration, type Migration } from "./migrate.ts";
import { socketAlive } from "./endpoints/unix.ts";

export function harnessHome(): string {
  const configured = process.env.HARNESS_HOME;
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".harness");
}

/** The home ready for use: moved from the flat layout if it is one, its directories made. Returns what the move did. */
export async function ensureHome(dir: string): Promise<Migration> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // an older hub answering on the flat layout's socket stops the move
  const oldSocket = join(dir, "sockets", "default.sock");
  const olderHubRuns = needsMigration(dir) && existsSync(oldSocket) && (await socketAlive(oldSocket));
  const migration = migrateHome(dir, olderHubRuns);
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(ignore, "*\n");
  } else {
    // there already
  }
  const layout = layoutOf(dir);
  for (const sub of [layout.agent, layout.hub, layout.sessions, layout.client, layout.run, layout.locks, layout.log]) {
    mkdirSync(sub, { recursive: true, mode: 0o700 });
  }
  return migration;
}
