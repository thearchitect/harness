// A lock file around a read-change-write of a file several processes write (harness.json from every
// agent, the TUI windows' state): created exclusively with the holder's PID, removed after; a lock
// whose process is gone is left over from a crash and taken over.

import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

/** How long a writer waits for another one before it gives up. */
const LOCK_WAIT_MS = 5_000;
/** A lock file without its PID yet is being taken; only this old is it left over. */
const UNWRITTEN_MS = 2_000;
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
      const held = holder(path);
      if (held === "gone") {
        return take(path); // released meanwhile
      } else if (held === "taking" || (typeof held === "number" && held !== process.pid && alive(held))) {
        return false;
      } else {
        // left over by a process that is gone (or by this one's crash)
        rmSync(path, { force: true });
        return take(path);
      }
    }
  }
}

/** Who holds a lock file: its PID; "taking" while its holder has not written the PID yet, "left" when it never did; "gone" once released. */
function holder(path: string): number | "taking" | "left" | "gone" {
  try {
    const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
    if (Number.isInteger(owner)) {
      return owner;
    } else {
      return Date.now() - statSync(path).mtimeMs < UNWRITTEN_MS ? "taking" : "left";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "gone";
    } else {
      throw error;
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
