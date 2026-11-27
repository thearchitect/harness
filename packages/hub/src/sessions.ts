// The user's sessions (pi's session files under ~/.harness/sessions) and the lock that keeps one
// session with at most one agent among all hubs of the user on this machine:
// ~/.harness/locks/<session id>.lock holds the owning hub's pid; a dead pid frees it.

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { branchPage } from "#protocol/entries.ts";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HarnessError } from "#protocol/errors.ts";
import type { SessionListItem } from "#protocol/hub.ts";

export function sessionsDir(dataDir: string): string {
  return join(dataDir, "sessions");
}

/** pi's directory of a cwd's sessions under the sessions directory (getDefaultSessionDirPath of its session manager). */
function cwdSessionsDir(dataDir: string, cwd: string): string {
  return join(sessionsDir(dataDir), `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/**
 * The user's saved sessions: of one directory, or all. pi keeps them per directory
 * (sessions/--<cwd>--/*.jsonl); its lists with a directory given read that directory alone, so all
 * of them are read directory by directory.
 */
export async function listSessions(dataDir: string, cwd?: string): Promise<Omit<SessionListItem, "agent">[]> {
  const sessions =
    cwd !== undefined
      ? await SessionManager.list(cwd, cwdSessionsDir(dataDir, cwd))
      : (
          await Promise.all(
            (await readdir(sessionsDir(dataDir), { withFileTypes: true }).catch(() => []))
              .filter((entry) => entry.isDirectory())
              .map((entry) => SessionManager.listAll(join(sessionsDir(dataDir), entry.name))),
          )
        ).flat();
  return sessions
    .map((session) => ({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      created: session.created.getTime(),
      modified: session.modified.getTime(),
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
    }))
    .sort((a, b) => b.modified - a.modified);
}

/** The branches of session files read last, by path (a client reads one page after another). */
const READ = new Map<string, { mtime: number; branch: { id: string }[] }>();
const READ_KEPT = 16;

/**
 * A stored session's entries without its agent (session_read): the page of its current branch that
 * harness_snapshot and harness_entries_before would give. Only files under the sessions directory.
 */
export function readSession(dataDir: string, file: string, cursor: string | undefined, limit: number): { entries: unknown[]; cursor?: string; mtime: number } {
  const path = resolve(file);
  if (!path.startsWith(`${resolve(sessionsDir(dataDir))}/`) || !path.endsWith(".jsonl")) {
    throw new HarnessError("forbidden", `${file} is not a session file of this node`);
  } else {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      throw new HarnessError("not_found", `no session file ${file}`);
    }
    const known = READ.get(path);
    const branch = known !== undefined && known.mtime === mtime ? known.branch : SessionManager.open(path).getBranch();
    READ.delete(path);
    READ.set(path, { mtime, branch });
    for (const old of [...READ.keys()].slice(0, Math.max(0, READ.size - READ_KEPT))) {
      READ.delete(old);
    }
    const page = branchPage(branch, cursor, limit);
    if (page === undefined) {
      throw new HarnessError("not_found", `entry ${cursor} is not on the current branch of ${file}`);
    } else {
      return { ...page, mtime };
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionLocks {
  private readonly dir: string;
  private readonly held = new Set<string>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "locks");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(sessionId: string): string {
    return join(this.dir, `${sessionId}.lock`);
  }

  /** Takes the session's lock for this process, or throws `session_locked` naming the holder. */
  acquire(sessionId: string): void {
    const path = this.path(sessionId);
    const content = JSON.stringify({ pid: process.pid, since: Date.now() });
    try {
      writeFileSync(path, content, { flag: "wx" });
      this.held.add(sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      } else {
        const holder = this.holder(sessionId);
        if (holder === process.pid && this.held.has(sessionId)) {
          throw new HarnessError("session_locked", `session ${sessionId} already has an agent on this node`);
        } else if (holder !== undefined && holder !== process.pid && alive(holder)) {
          throw new HarnessError("session_locked", `session ${sessionId} is served by another node (pid ${holder})`);
        } else {
          // a stale lock: its holder is gone
          rmSync(path, { force: true });
          this.acquire(sessionId);
        }
      }
    }
  }

  release(sessionId: string): void {
    if (this.held.delete(sessionId)) {
      rmSync(this.path(sessionId), { force: true });
    } else {
      // not ours
    }
  }

  releaseAll(): void {
    for (const sessionId of [...this.held]) {
      this.release(sessionId);
    }
  }

  private holder(sessionId: string): number | undefined {
    try {
      const data = JSON.parse(readFileSync(this.path(sessionId), "utf8")) as { pid?: unknown };
      return typeof data.pid === "number" ? data.pid : undefined;
    } catch {
      return undefined; // unreadable: treated as stale
    }
  }
}
