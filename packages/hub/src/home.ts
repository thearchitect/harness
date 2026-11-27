// The user's harness directory: $HARNESS_HOME, else ~/.harness. Created on first use with a
// `.gitignore` that ignores everything (it holds credentials and sessions) and private sockets.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function harnessHome(): string {
  const configured = process.env.HARNESS_HOME;
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".harness");
}

export function ensureHome(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(ignore, "*\n");
  } else {
    // there already
  }
  for (const sub of ["sessions", "sockets", "locks", "log"]) {
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  }
}
