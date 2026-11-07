/**
 * The gateway's durable state, one JSON file on the volume (root, 0600):
 * which Telegram topic is which pi session, the pinned status cards, the
 * users' recent directories and which keyboard they have. Every change is written at once, atomically (temp file +
 * rename), so a crash or a deploy never leaves a half-written file.
 *
 * Held first messages, open dialogs and pending inputs are not here: they live
 * in memory, and the gateway does not stop for idleness while any exists.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TurnMode = "plan" | "build";

export type TopicState = {
  userId: number;
  threadId: number;
  /** Absolute working directory of the session (inside the user's home). */
  cwd: string;
  /** The pi session id (`pi --session-id`). */
  sessionId: string;
  title: string;
  cardMessageId?: number;
  /** Mode of the next message sent to the topic; back to plan after each message. */
  nextMode: TurnMode;
  closed: boolean;
};

export type UserState = {
  /** Most recent first, at most RECENT_DIRS_LIMIT. */
  recentDirs: string[];
  /** card.ts KEYBOARD_VERSION the user's chat has; absent: none yet. */
  keyboardVersion?: number;
};

type StateFile = {
  version: 2;
  users: Record<string, UserState>;
  topics: TopicState[];
  /** Topics of the gateway's earlier version to delete once (v1: the Account topics). */
  obsoleteTopics?: { userId: number; threadId: number }[];
};

/** Version 1: users had an Account topic with a pinned card. */
type StateFileV1 = {
  version: 1;
  users: Record<string, { accountThreadId?: number; recentDirs: string[] }>;
  topics: TopicState[];
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
        return { version: 2, users: {}, topics: [] };
      } else {
        throw new Error(`cannot read ${path}: ${(error as Error).message}`);
      }
    }
    const parsed = JSON.parse(text) as { version?: unknown };
    if (parsed.version === 2) {
      return parsed as StateFile;
    } else if (parsed.version === 1) {
      const v1 = parsed as StateFileV1;
      return {
        version: 2,
        users: Object.fromEntries(Object.entries(v1.users).map(([id, user]) => [id, { recentDirs: user.recentDirs }])),
        topics: v1.topics,
        obsoleteTopics: Object.entries(v1.users).flatMap(([id, user]) =>
          user.accountThreadId !== undefined ? [{ userId: Number(id), threadId: user.accountThreadId }] : [],
        ),
      };
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

  /** Topics left by an earlier version, to delete once (then forgetObsolete). */
  obsoleteTopics(): { userId: number; threadId: number }[] {
    return [...(this.data.obsoleteTopics ?? [])];
  }

  forgetObsolete(): void {
    delete this.data.obsoleteTopics;
    this.save();
  }

  user(userId: number): UserState {
    return this.data.users[String(userId)] ?? { recentDirs: [] };
  }

  updateUser(userId: number, change: (user: UserState) => void): UserState {
    const user = structuredClone(this.user(userId));
    change(user);
    this.data.users[String(userId)] = user;
    this.save();
    return user;
  }

  /** The user's most recent directories first, deduplicated. */
  rememberDir(userId: number, dir: string): void {
    this.updateUser(userId, (user) => {
      user.recentDirs = [dir, ...user.recentDirs.filter((d) => d !== dir)].slice(0, RECENT_DIRS_LIMIT);
    });
  }

  topic(userId: number, threadId: number): TopicState | undefined {
    return this.data.topics.find((t) => t.userId === userId && t.threadId === threadId);
  }

  topics(userId: number): TopicState[] {
    return this.data.topics.filter((t) => t.userId === userId);
  }

  addTopic(topic: TopicState): void {
    this.data.topics = [...this.data.topics.filter((t) => !(t.userId === topic.userId && t.threadId === topic.threadId)), topic];
    this.save();
  }

  updateTopic(userId: number, threadId: number, change: (topic: TopicState) => void): TopicState {
    const topic = this.topic(userId, threadId);
    if (topic === undefined) {
      throw new Error(`no topic ${threadId} of user ${userId}`);
    } else {
      change(topic);
      this.save();
      return topic;
    }
  }
}
