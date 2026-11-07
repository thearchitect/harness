/**
 * New conversations: a topic the gateway does not know yet becomes a session
 * once the user picks its directory, with one tap.
 *
 * The first message (and any that follow before the choice) is held; the bot
 * answers with the choice — ~, the user's recent directories, the
 * subdirectories of ~, "Path…" — as the topic's last message. With nothing to
 * choose from, the session starts in ~ at once. The chosen directory names the
 * topic when the topic's name was not chosen by the user.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homeOf } from "./accounts.ts";
import type { Config, UserConfig } from "./config.ts";
import { Outbox } from "./outbox.ts";
import { escapeHtml } from "./render.ts";
import type { UserInput } from "./session.ts";
import { displayDir } from "./session.ts";
import type { StateStore } from "./state.ts";
import type { Tg } from "./tg.ts";

export type BinderDeps = {
  config: Config;
  store: StateStore;
  tg: Tg;
  log(line: string): void;
  now(): number;
  /** Binds the topic to a new session in `cwd` and sends it the held inputs. */
  bind(user: UserConfig, threadId: number, cwd: string, title: string, held: UserInput[]): Promise<void>;
};

const SUBDIRS_LIMIT = 15;
/** A mobile client creates the topic first, then delivers the message to All; they belong together within this window. */
const ADOPT_WINDOW_MS = 10_000;
/** Names Telegram clients give new topics when the user names nothing. */
const DEFAULT_TOPIC_NAMES = new Set(["new topic", "new chat", "topic"]);

type Pending = {
  user: UserConfig;
  threadId: number;
  outbox: Outbox;
  held: UserInput[];
  options: string[];
  awaitingPath: boolean;
};

export class TopicBinder {
  private readonly deps: BinderDeps;
  /** Topic names seen in forum_topic_created, and whether the bot may rename them. */
  private readonly names = new Map<string, { name: string; renamable: boolean; implicitAt?: number }>();
  private readonly pending = new Map<string, Pending>();

  constructor(deps: BinderDeps) {
    this.deps = deps;
  }

  get quiescent(): boolean {
    return this.pending.size === 0;
  }

  /**
   * A topic was created: by a client (the service message tells whether its
   * name is implicit) or by the bot (always renamable).
   */
  noteCreated(userId: number, threadId: number, name: string, source: "client" | "client-implicit" | "bot"): void {
    const renamable = source !== "client" || DEFAULT_TOPIC_NAMES.has(name.trim().toLowerCase());
    this.names.set(key(userId, threadId), { name, renamable, implicitAt: source === "client-implicit" ? this.deps.now() : undefined });
  }

  /** The topic a client created implicitly just before delivering a message to All, if any. */
  adoptRecentImplicit(userId: number): number | undefined {
    const now = this.deps.now();
    for (const [k, info] of this.names) {
      const [user, thread] = k.split(":").map(Number);
      if (user === userId && thread !== undefined && info.implicitAt !== undefined && now - info.implicitAt <= ADOPT_WINDOW_MS && !this.pending.has(k)) {
        info.implicitAt = undefined;
        return thread;
      } else {
        // another user's topic, an older one, or one in use
      }
    }
    return undefined;
  }

  /** A topic a client just created with an implicit name and nothing in it yet. */
  isFreshImplicit(userId: number, threadId: number): boolean {
    return this.names.get(key(userId, threadId))?.implicitAt !== undefined && !this.pending.has(key(userId, threadId));
  }

  /** A message in a topic without a session. */
  async message(user: UserConfig, threadId: number, input: UserInput): Promise<void> {
    const k = key(user.telegramId, threadId);
    const pending = this.pending.get(k);
    if (pending === undefined) {
      const options = this.options(user);
      if (options.length === 1) {
        await this.finish({ user, threadId, outbox: this.outbox(user, threadId), held: [input], options, awaitingPath: false }, options[0] as string);
      } else {
        const created: Pending = { user, threadId, outbox: this.outbox(user, threadId), held: [input], options, awaitingPath: false };
        this.pending.set(k, created);
        await created.outbox.send({ html: "📁 <b>Where to work?</b>" }, { role: "sticky", silent: false, keyboard: this.keyboard(user, options) });
      }
    } else if (pending.awaitingPath) {
      await pending.outbox.userPosted();
      const chosen = this.resolvePath(user, input.text.trim());
      if ("problem" in chosen) {
        await pending.outbox.send({ html: `❌ ${escapeHtml(chosen.problem)}` }, { silent: false });
      } else {
        await this.finish(pending, chosen.dir);
      }
    } else {
      pending.held.push(input);
      await pending.outbox.userPosted();
    }
  }

  /** /new <path>: binds a fresh topic to the path at once; resolves with the problem, if any. */
  async openAt(user: UserConfig, threadId: number, path: string): Promise<string | undefined> {
    const chosen = this.resolvePath(user, path);
    if ("problem" in chosen) {
      return chosen.problem;
    } else {
      await this.finish({ user, threadId, outbox: this.outbox(user, threadId), held: [], options: [], awaitingPath: false }, chosen.dir);
      return undefined;
    }
  }

  /** A choice button: `p:<index>` or `p:path`. */
  async press(user: UserConfig, threadId: number, action: string): Promise<string> {
    const pending = this.pending.get(key(user.telegramId, threadId));
    if (pending === undefined) {
      return "This choice is closed.";
    } else if (action === "path") {
      pending.awaitingPath = true;
      await pending.outbox.editSticky({ html: "📁 <b>Where to work?</b>\nReply with a path relative to <code>~</code>:" }, []);
      return "Type the path";
    } else {
      const dir = pending.options[Number(action)];
      if (dir === undefined) {
        return "Unknown option";
      } else {
        await this.finish(pending, dir);
        return displayDir(dir, this.deps.config, user);
      }
    }
  }

  private async finish(pending: Pending, dir: string): Promise<void> {
    const { user, threadId } = pending;
    this.pending.delete(key(user.telegramId, threadId));
    const title = displayDir(dir, this.deps.config, user);
    if (pending.outbox.hasSticky) {
      await pending.outbox.closeSticky({ html: `📁 <b>${escapeHtml(title)}</b>` });
    } else {
      // started in ~ without a choice
    }
    await pending.outbox.flush();
    const name = this.names.get(key(user.telegramId, threadId));
    this.names.delete(key(user.telegramId, threadId));
    if (name?.renamable === true) {
      await this.deps.tg
        .editForumTopic(user.telegramId, threadId, { name: title.slice(0, 128) })
        .catch((error: unknown) => this.deps.log(`${user.name}/${threadId}: rename: ${String(error)}`));
    } else {
      // the user named the topic, or the name is unknown: keep it
    }
    this.deps.store.rememberDir(user.telegramId, dir);
    await this.deps.bind(user, threadId, dir, name?.renamable === true ? title : (name?.name ?? title), pending.held);
  }

  /** ~, the recent directories that still exist, then the subdirectories of ~. */
  private options(user: UserConfig): string[] {
    const home = homeOf(this.deps.config, user);
    const recent = this.deps.store
      .user(user.telegramId)
      .recentDirs.filter((dir) => dir !== home && isInside(home, dir) && isDirectory(dir));
    let subdirs: string[] = [];
    try {
      subdirs = readdirSync(home, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => resolve(home, entry.name))
        .filter((dir) => !recent.includes(dir))
        .sort()
        .slice(0, SUBDIRS_LIMIT);
    } catch (error) {
      this.deps.log(`${user.name}: cannot list ${home}: ${(error as Error).message}`);
    }
    return [home, ...recent, ...subdirs];
  }

  private keyboard(user: UserConfig, options: string[]): { text: string; callback_data: string }[][] {
    const buttons = options.map((dir, index) => ({ text: displayDir(dir, this.deps.config, user), callback_data: `p:${index}` }));
    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([{ text: "📁 Path…", callback_data: "p:path" }]);
    return rows;
  }

  private resolvePath(user: UserConfig, path: string): { dir: string } | { problem: string } {
    const home = homeOf(this.deps.config, user);
    const relative = path.replace(/^~\/?/, "");
    const candidate = resolve(home, relative);
    if (!existsSync(candidate)) {
      return { problem: `${path} does not exist. Reply with another path:` };
    } else {
      const real = realpathSync(candidate);
      if (!isInside(home, real) && real !== home) {
        return { problem: `${path} is outside your home. Reply with another path:` };
      } else if (!statSync(real).isDirectory()) {
        return { problem: `${path} is not a directory. Reply with another path:` };
      } else {
        return { dir: real };
      }
    }
  }

  private outbox(user: UserConfig, threadId: number): Outbox {
    return new Outbox(this.deps.tg, user.telegramId, threadId, (line) => this.deps.log(`${user.name}/${threadId}: ${line}`), () => {
      // the user deleted the topic before choosing: forget it
      this.pending.delete(key(user.telegramId, threadId));
    });
  }
}

function key(userId: number, threadId: number): string {
  return `${userId}:${threadId}`;
}

function isInside(home: string, dir: string): boolean {
  return dir === home || dir.startsWith(`${home}/`);
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
