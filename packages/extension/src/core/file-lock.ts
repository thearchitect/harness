// A lock file around a read-change-write of a file several processes write (harness.json from every
// agent, the TUI windows' state): created exclusively with the holder's PID, removed after; a lock
// whose process is gone is left over from a crash and taken over.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

/** How long a writer waits for another one before it gives up. */
const LOCK_WAIT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function take(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    } else {
      const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) {
        return false;
      } else {
        rmSync(path, { force: true });
        return take(path);
      }
    }
  }
}

/** Runs `change` while holding the lock file `path` (`<file>.lock`); throws when another writer keeps it too long. */
export function withFileLock<T>(path: string, change: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!take(path)) {
    if (Date.now() > deadline) {
      throw new Error(`${path}: another process holds the lock`);
    } else {
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return change();
  } finally {
    rmSync(path, { force: true });
  }
}
