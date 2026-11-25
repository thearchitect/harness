// Arguments of `harness` that need more than parseArgs.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** The directory a TUI start works in: `harness [dir]`, the current one by default. */
export function sessionDirectory(positionals: readonly string[], base = process.cwd()): string {
  if (positionals.length > 1) {
    throw new Error(`one directory at most, got: ${positionals.join(" ")}`);
  } else if (positionals[0] === undefined) {
    return base;
  } else {
    const dir = resolve(base, positionals[0]);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`${positionals[0]} is not a directory`);
    } else {
      return dir;
    }
  }
}
