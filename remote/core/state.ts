/**
 * The gateway's durable state, one JSON file on the volume (root, 0600): the
 * workspaces with the agent each one holds, and the users' recent
 * directories. Every change is written at once, atomically (temp file +
 * rename), so a crash or a deploy never leaves a half-written file.
 *
 * Background agents are not here: they live as long as their process, which
 * does not survive the gateway. Attachments do: an attached agent's process
 * starts again on the next message.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WorkspaceKind = "private" | "group";

/** The agent a workspace holds: a pi session in a directory. */
export type Attachment = { sessionId: string; cwd: string };

export type WorkspaceState = {
  chatId: number;
  kind: WorkspaceKind;
  /** The Telegram id of the user who owns it (the user themselves for their private chat). */
  owner: number;
  title: string;
  agent?: Attachment;
};

export type UserState = {
  /** Most recent first, at most RECENT_DIRS_LIMIT. */
  recentDirs: string[];
};

type StateFile = {
  version: 4;
  users: Record<string, UserState>;
  workspaces: WorkspaceState[];
};

export const RECENT_DIRS_LIMIT = 5;

export class StateStore {
  private readonly path: string;
  private data: StateFile;

  constructor(path: string) {
    this.path = path;
    this.data = StateStore.read(path);
  }

  private static read(path: string): StateFile {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 4, users: {}, workspaces: [] };
      } else {
        throw new Error(`cannot read ${path}: ${(error as Error).message}`);
      }
    }
    const parsed = JSON.parse(text) as { version?: unknown };
    if (parsed.version === 4) {
      return parsed as StateFile;
    } else {
      throw new Error(`${path}: unsupported state version ${String(parsed.version)} (remove the file to start over)`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  user(userId: number): UserState {
    return this.data.users[String(userId)] ?? { recentDirs: [] };
  }

  /** The user's most recent directories first, deduplicated. */
  rememberDir(userId: number, dir: string): void {
    const user = this.user(userId);
    this.data.users[String(userId)] = { ...user, recentDirs: [dir, ...user.recentDirs.filter((d) => d !== dir)].slice(0, RECENT_DIRS_LIMIT) };
    this.save();
  }

  workspace(chatId: number): WorkspaceState | undefined {
    return this.data.workspaces.find((w) => w.chatId === chatId);
  }

  workspaces(): WorkspaceState[] {
    return [...this.data.workspaces];
  }

  /** The workspaces of one user. */
  owned(userId: number): WorkspaceState[] {
    return this.data.workspaces.filter((w) => w.owner === userId);
  }

  /** The workspace holding the agent of this session, if any. */
  holding(sessionId: string): WorkspaceState | undefined {
    return this.data.workspaces.find((w) => w.agent?.sessionId === sessionId);
  }

  addWorkspace(workspace: WorkspaceState): void {
    if (this.workspace(workspace.chatId) !== undefined) {
      throw new Error(`workspace ${workspace.chatId} exists`);
    } else {
      this.data.workspaces.push(workspace);
      this.save();
    }
  }

  updateWorkspace(chatId: number, change: (workspace: WorkspaceState) => void): void {
    const workspace = this.workspace(chatId);
    if (workspace === undefined) {
      throw new Error(`no workspace ${chatId}`);
    } else {
      change(workspace);
      this.save();
    }
  }

  removeWorkspace(chatId: number): void {
    this.data.workspaces = this.data.workspaces.filter((w) => w.chatId !== chatId);
    this.save();
  }
}
