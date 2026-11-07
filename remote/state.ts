/**
 * The gateway's durable state, one JSON file on the volume (root, 0600):
 * the agents (which place of which user runs which pi session, in which
 * directory) and the users' recent directories. Every change is written at
 * once, atomically (temp file + rename), so a crash or a deploy never leaves a
 * half-written file.
 *
 * A place is a topic of the private chat (its thread id) or All (no thread
 * id); it holds at most one agent. Open dialogs and pending inputs live in
 * memory, and the gateway does not stop for idleness while any exists.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A topic's thread id; undefined is All. */
export type Place = number | undefined;

export type AgentState = {
  userId: number;
  threadId?: number;
  /** Absolute working directory of the session (inside the user's home). */
  cwd: string;
  /** The pi session id (`pi --session-id`). */
  sessionId: string;
  /** The pinned status line. */
  cardMessageId?: number;
};

export type UserState = {
  /** Most recent first, at most RECENT_DIRS_LIMIT. */
  recentDirs: string[];
};

type StateFile = {
  version: 3;
  users: Record<string, UserState>;
  agents: AgentState[];
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
        return { version: 3, users: {}, agents: [] };
      } else {
        throw new Error(`cannot read ${path}: ${(error as Error).message}`);
      }
    }
    const parsed = JSON.parse(text) as { version?: unknown };
    if (parsed.version === 3) {
      return parsed as StateFile;
    } else {
      throw new Error(`${path}: unsupported state version ${String(parsed.version)}`);
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

  agent(userId: number, place: Place): AgentState | undefined {
    return this.data.agents.find((a) => a.userId === userId && a.threadId === place);
  }

  agents(userId: number): AgentState[] {
    return this.data.agents.filter((a) => a.userId === userId);
  }

  addAgent(agent: AgentState): void {
    if (this.agent(agent.userId, agent.threadId) !== undefined) {
      throw new Error(`place ${agent.threadId ?? "All"} of user ${agent.userId} already has an agent`);
    } else {
      this.data.agents.push(agent);
      this.save();
    }
  }

  updateAgent(userId: number, place: Place, change: (agent: AgentState) => void): void {
    const agent = this.agent(userId, place);
    if (agent === undefined) {
      throw new Error(`no agent in place ${place ?? "All"} of user ${userId}`);
    } else {
      change(agent);
      this.save();
    }
  }

  removeAgent(userId: number, place: Place): void {
    this.data.agents = this.data.agents.filter((a) => !(a.userId === userId && a.threadId === place));
    this.save();
  }
}
