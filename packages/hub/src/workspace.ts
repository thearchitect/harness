// The user's workspace on this hub (~/.harness/hub/workspace.json): the open tabs of its sessions, in
// their order, each with what has been seen of it and the message being written there (its draft,
// shared by every device: begun on one, finished on another). A session belongs here once it
// differs from a new one — a message, a draft, a name — and leaves when it is closed, or when it
// has no message and its draft is wiped (it is its window's alone again). Changes carry the
// revision they were made on (a stale one is refused: the client applies its change again).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HarnessError } from "#protocol/errors.ts";
import { layoutOf } from "#protocol/layout.ts";
import type { WorkspaceData, WorkspaceTab } from "#protocol/hub.ts";

export class Workspace {
  private readonly path: string;
  private readonly listeners = new Set<(workspace: WorkspaceData) => void>();

  constructor(dataDir: string) {
    this.path = layoutOf(dataDir).workspace;
  }

  read(): WorkspaceData {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Partial<WorkspaceData>;
      return { revision: typeof data.revision === "number" ? data.revision : 0, tabs: Array.isArray(data.tabs) ? data.tabs.filter((tab) => typeof tab?.sessionId === "string") : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { revision: 0, tabs: [] };
      } else {
        throw new Error(`${this.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private write(tabs: WorkspaceTab[]): WorkspaceData {
    const next = { revision: this.read().revision + 1, tabs };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  /** The tabs as a client arranged them (order, seen, closed ones gone); drafts stay the hub's. */
  setTabs(tabs: WorkspaceTab[], ifRevision: number): WorkspaceData {
    const current = this.read();
    if (current.revision !== ifRevision) {
      throw new HarnessError("conflict", "the workspace changed meanwhile: apply the change to its current value");
    } else {
      const drafts = new Map(current.tabs.map((tab) => [tab.sessionId, tab.draft]));
      return this.write(tabs.map(({ draft: _draft, ...tab }) => ({ ...tab, ...(drafts.get(tab.sessionId) !== undefined ? { draft: drafts.get(tab.sessionId) } : {}) })));
    }
  }

  /**
   * A session's draft: it joins the tabs when it differs from a new session (text, `keep`: a
   * message or a name), and leaves them when it does not and has no message on disk. The last write
   * wins.
   */
  setDraft(tab: Omit<WorkspaceTab, "draft" | "seen">, text: string, keep: boolean, now: number): WorkspaceData {
    const current = this.read();
    const known = current.tabs.find((candidate) => candidate.sessionId === tab.sessionId);
    const changed = text !== "" || keep || existsSync(tab.sessionFile);
    if (known === undefined && !changed) {
      return current; // a new session's: its window's alone
    } else if (known === undefined) {
      return this.write([...current.tabs, { ...tab, ...(text !== "" ? { draft: { text, at: now } } : {}) }]);
    } else if (!changed) {
      return this.write(current.tabs.filter((candidate) => candidate !== known));
    } else if ((known.draft?.text ?? "") === text && known.sessionFile === tab.sessionFile) {
      return current; // as it is
    } else {
      const { draft: _draft, ...rest } = known;
      return this.write(current.tabs.map((candidate) => (candidate === known ? { ...rest, sessionFile: tab.sessionFile, ...(text !== "" ? { draft: { text, at: now } } : {}) } : candidate)));
    }
  }

  /** A tab's session started anew in its place (its file was never written): the same tab, the new session. */
  replaceSession(sessionId: string, next: { sessionId: string; sessionFile: string }): WorkspaceData {
    const current = this.read();
    return this.write(current.tabs.map((tab) => (tab.sessionId === sessionId ? { ...tab, ...next } : tab)));
  }

  onChange(listener: (workspace: WorkspaceData) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
