/**
 * Routing of Telegram updates: only private chats of configured users; per
 * user, updates are handled strictly in order.
 *
 * - All (no topic): a task starts a new topic (the message moves into it);
 *   account commands answer in the Account topic.
 * - The Account topic: its card, login and secrets inputs.
 * - A topic with a session: messages, commands, card and dialog buttons.
 * - Any other topic: a new conversation (topics.ts).
 *
 * Gateway commands are handled here; any other /command goes to pi.
 */

import { randomUUID } from "node:crypto";
import type { Message, Update } from "grammy/types";
import { Account } from "./account.ts";
import { homeOf, runAsUser } from "./accounts.ts";
import type { UserConfig } from "./config.ts";
import type { LoginCallbacks, LoginRun } from "./login.ts";
import { escapeHtml } from "./render.ts";
import { displayDir, TopicSession, type SessionDeps, type UserInput } from "./session.ts";

import { TopicBinder } from "./topics.ts";

export type GatewayDeps = SessionDeps & {
  startLogin(user: UserConfig, args: string[], callbacks: LoginCallbacks): LoginRun;
  /** Downloads a file the user sent (Bot API getFile + file URL). */
  download(fileId: string): Promise<Buffer>;
  /** Called for every accepted update (idle shutdown). */
  activity(): void;
};

/** Telegram's limit for files a bot may download. */
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export const BOT_COMMANDS = [
  { command: "new", description: "New session: /new [path]" },
  { command: "build", description: "Build: /build [task] (or next message)" },
  { command: "plan", description: "Plan: /plan [task] (or next message)" },
  { command: "stop", description: "Stop the agent" },
  { command: "model", description: "Choose the model" },
  { command: "thinking", description: "Choose the thinking level" },
  { command: "compact", description: "Compact the context" },
  { command: "close", description: "Close this session" },
  { command: "account", description: "Logins, secrets, server key" },
  { command: "help", description: "How this works" },
];

const ACCOUNT_COMMANDS = new Set(["account", "login", "logout", "secret", "secrets", "whoami", "sessions"]);

const HELP = [
  "<b>harness</b> — a coding agent per topic.",
  "• Write a task in a new topic (or in All); pick the directory; the agent plans.",
  "• Build: the pinned card's 🔨 Build (next message), <code>!</code> before the text, or 🔨 Build after a plan.",
  "• Write while it works to steer; ⏹ (draft or card) or /stop stops it.",
  "• The pinned card: model, thinking, compact, close. ⚙️ Account: logins, secrets, your server key.",
].join("\n");

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly users = new Map<number, UserConfig>();
  private readonly sessions = new Map<string, TopicSession>();
  private readonly accounts = new Map<number, Account>();
  private readonly chains = new Map<number, Promise<void>>();
  private readonly binder: TopicBinder;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    for (const user of deps.config.users) this.users.set(user.telegramId, user);
    this.binder = new TopicBinder({
      config: deps.config,
      store: deps.store,
      tg: deps.tg,
      log: deps.log,
      now: () => deps.clock.now(),
      bind: (user, threadId, cwd, title, held) => this.bind(user, threadId, cwd, title, held),
    });
  }

  /** Nothing runs or waits for the user anywhere. */
  isQuiescent(): boolean {
    return (
      this.deps.pool.isQuiescent() &&
      this.binder.quiescent &&
      [...this.sessions.values()].every((s) => s.quiescent) &&
      [...this.accounts.values()].every((a) => a.quiescent)
    );
  }

  /** Accepts an update; resolves when it has been handled (in order with the user's earlier updates). */
  onUpdate(update: Update): Promise<void> {
    const from = update.message?.from ?? update.edited_message?.from ?? update.callback_query?.from ?? update.stopped_message_generation?.chat;
    const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat ?? update.stopped_message_generation?.chat;
    const user = from !== undefined ? this.users.get(from.id) : undefined;
    if (user === undefined || chat === undefined || chat.type !== "private" || chat.id !== user.telegramId) {
      this.deps.log(`ignored update ${update.update_id} from ${from?.id ?? "?"} (${(from as { username?: string } | undefined)?.username ?? "no username"})`);
      return Promise.resolve();
    }
    this.deps.activity();
    const previous = this.chains.get(user.telegramId) ?? Promise.resolve();
    const next = previous.then(() => this.route(user, update)).catch((error: unknown) => {
      this.deps.log(`${user.name}: update ${update.update_id} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
    this.chains.set(user.telegramId, next);
    return next;
  }

  /** The gateway stops: running runs are interrupted with a notice, processes stop. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.shutdown()));
    await this.deps.pool.stopAll();
    await Promise.all([...this.sessions.values()].map((s) => s.outbox.flush()));
  }

  /* ------------------------------------------------------------------------ */

  private async route(user: UserConfig, update: Update): Promise<void> {
    if (update.message !== undefined) {
      await this.onMessage(user, update.message);
    } else if (update.callback_query !== undefined) {
      const query = update.callback_query;
      const toast = await this.onButton(user, query.message?.message_thread_id, query.data ?? "");
      await this.deps.tg.answerCallbackQuery(query.id, { text: toast.slice(0, 200) }).catch((error: unknown) => this.deps.log(`answerCallbackQuery: ${String(error)}`));
    } else if (update.stopped_message_generation !== undefined) {
      const threadId = update.stopped_message_generation.message_thread_id;
      if (threadId !== undefined) await this.session(user, threadId)?.stop();
    } else if (update.edited_message !== undefined) {
      const threadId = update.edited_message.message_thread_id;
      await this.deps.tg
        .sendMessage(user.telegramId, "Edits are not applied — send a new message.", { message_thread_id: threadId, reply_parameters: { message_id: update.edited_message.message_id } })
        .catch((error: unknown) => this.deps.log(`edited_message reply: ${String(error)}`));
    } else {
      // other update kinds are not used
    }
  }

  private async onMessage(user: UserConfig, message: Message): Promise<void> {
    const threadId = message.is_topic_message === true ? message.message_thread_id : undefined;
    if (message.forum_topic_created !== undefined) {
      if (threadId !== undefined) {
        const implicit = message.forum_topic_created.is_name_implicit === true;
        this.binder.noteCreated(user.telegramId, threadId, message.forum_topic_created.name, implicit ? "client-implicit" : "client");
      } else {
        // a topic is always a topic message
      }
      return;
    }
    const text = message.text ?? message.caption;
    if (text === undefined && message.photo === undefined && message.document === undefined) {
      return; // service messages (pins, topic edits) and unsupported content
    }
    const command = parseCommand(message.text);
    const account = this.account(user);
    const topic = threadId !== undefined ? this.deps.store.topic(user.telegramId, threadId) : undefined;

    if (command !== undefined && ACCOUNT_COMMANDS.has(command.name)) {
      await account.command(command.name);
      if (threadId !== undefined && topic === undefined && this.binder.isFreshImplicit(user.telegramId, threadId)) {
        // a client created this topic just to carry the command: remove it
        await this.deps.tg.deleteForumTopic(user.telegramId, threadId).catch((error: unknown) => this.deps.log(`deleteForumTopic: ${String(error)}`));
      } else {
        // the command came from a topic in use
      }
    } else if (command?.name === "new") {
      await this.newTopic(user, command.args);
    } else if (command?.name === "help" || command?.name === "start") {
      await this.reply(user, threadId, HELP);
      if (command.name === "start") await account.ensure();
    } else if (threadId !== undefined && threadId === account.threadId) {
      if (command?.name === "stop") {
        await account.stop();
      } else {
        await account.text(text ?? "", message.message_id);
      }
    } else if (topic !== undefined) {
      await this.inSession(user, topic.threadId, message, command, text ?? "");
    } else if (threadId !== undefined) {
      const input = await this.input(user, threadId, message, text ?? "");
      if (input !== undefined) await this.binder.message(user, threadId, input);
    } else {
      await this.fromAll(user, message, text ?? "");
    }
  }

  private async inSession(user: UserConfig, threadId: number, message: Message, command: { name: string; args: string } | undefined, text: string): Promise<void> {
    const session = this.session(user, threadId);
    if (session === undefined) return;
    switch (command?.name) {
      case "stop":
        await session.stop();
        return;
      case "model":
        await session.card("models", "0");
        return;
      case "thinking":
      case "compact":
      case "close":
        await session.card(command.name, undefined);
        return;
      case "build":
      case "plan":
        if (command.args === "") {
          await session.card("mode", command.name);
        } else {
          await session.userInput({ text: command.name === "build" ? `!${command.args}` : command.args, messageId: message.message_id });
        }
        return;
      default: {
        const input = await this.input(user, threadId, message, text);
        if (input !== undefined) await session.userInput(input);
        return;
      }
    }
  }

  /** A message outside topics: it moves into a new topic of its own. */
  private async fromAll(user: UserConfig, message: Message, text: string): Promise<void> {
    if (text.startsWith("/")) {
      await this.reply(user, undefined, "Commands for a session work inside its topic. /new starts one.");
      return;
    }
    // A mobile client has just created a topic for this message: use it.
    let threadId = this.binder.adoptRecentImplicit(user.telegramId);
    if (threadId === undefined) {
      const name = (text.trim().split("\n")[0] ?? "").slice(0, 32) || "New session";
      try {
        threadId = (await this.deps.tg.createForumTopic(user.telegramId, name)).message_thread_id;
      } catch (error) {
        this.deps.log(`${user.name}: createForumTopic: ${String(error)}`);
        return;
      }
      this.binder.noteCreated(user.telegramId, threadId, name, "bot");
    } else {
      // adopted the client's topic
    }
    let copiedId = message.message_id;
    try {
      copiedId = (await this.deps.tg.copyMessage(user.telegramId, user.telegramId, message.message_id, { message_thread_id: threadId })).message_id;
      await this.deps.tg.deleteMessage(user.telegramId, message.message_id);
    } catch (error) {
      this.deps.log(`${user.name}: moving the message into topic ${threadId}: ${String(error)}`);
    }
    const input = await this.input(user, threadId, { ...message, message_id: copiedId }, text);
    if (input !== undefined) await this.binder.message(user, threadId, input);
  }

  private async newTopic(user: UserConfig, path: string): Promise<void> {
    const name = path !== "" ? path.slice(0, 64) : "New session";
    let threadId: number;
    try {
      threadId = (await this.deps.tg.createForumTopic(user.telegramId, name)).message_thread_id;
    } catch (error) {
      this.deps.log(`${user.name}: createForumTopic: ${String(error)}`);
      return;
    }
    this.binder.noteCreated(user.telegramId, threadId, name, "bot");
    if (path === "") {
      await this.reply(user, threadId, "Write the task here — I'll ask where to work.");
    } else {
      const problem = await this.binder.openAt(user, threadId, path);
      await this.reply(user, threadId, problem !== undefined ? `❌ ${escapeHtml(problem)}` : "Write the task.");
    }
  }

  private async onButton(user: UserConfig, threadId: number | undefined, data: string): Promise<string> {
    const [kind, action = "", arg] = data.split(":");
    const session = threadId !== undefined ? this.session(user, threadId) : undefined;
    switch (kind) {
      case "a":
        return this.account(user).card(action, arg);
      case "l":
        return this.account(user).loginChoice(Number(action));
      case "p":
        return threadId !== undefined ? this.binder.press(user, threadId, action) : "Unknown topic";
      case "c":
        return session !== undefined ? session.card(action, arg) : "This session is gone";
      case "d":
        return session !== undefined ? session.dialogButton(Number(action), arg ?? "") : "This session is gone";
      case "r":
        return session !== undefined ? session.runButton(action) : "This session is gone";
      default:
        return "Unknown button";
    }
  }

  /** The message as a prompt input: text, photos as images, documents saved to the inbox. */
  private async input(user: UserConfig, threadId: number, message: Message, text: string): Promise<UserInput | undefined> {
    let body = text;
    const reply = message.reply_to_message;
    if (reply !== undefined && reply.forum_topic_created === undefined && reply.from?.is_bot === true) {
      const quoted = (reply.text ?? reply.caption ?? "").slice(0, 500);
      if (quoted !== "") body = `${body}\n\n[in reply to: ${quoted}]`;
    }
    const images: { data: string; mimeType: string }[] = [];
    if (message.photo !== undefined && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      if (largest !== undefined) {
        try {
          images.push({ data: (await this.deps.download(largest.file_id)).toString("base64"), mimeType: "image/jpeg" });
        } catch (error) {
          await this.reply(user, threadId, `❌ Could not download the photo: ${escapeHtml(String(error))}`);
          return undefined;
        }
      }
    } else if (message.document !== undefined) {
      const doc = message.document;
      if ((doc.file_size ?? 0) > DOWNLOAD_LIMIT) {
        await this.reply(user, threadId, "❌ Files over 20 MB cannot be received through Telegram.");
        return undefined;
      }
      const saved = await this.saveDocument(user, threadId, doc.file_id, doc.file_name ?? `file-${message.message_id}`);
      if ("problem" in saved) {
        await this.reply(user, threadId, `❌ ${escapeHtml(saved.problem)}`);
        return undefined;
      }
      body = `${body}\n\n[attached file: ${saved.path}]`.trim();
    } else {
      // text only
    }
    return { text: body, images: images.length > 0 ? images : undefined, messageId: message.message_id };
  }

  private async saveDocument(user: UserConfig, threadId: number, fileId: string, fileName: string): Promise<{ path: string } | { problem: string }> {
    let content: Buffer;
    try {
      content = await this.deps.download(fileId);
    } catch (error) {
      return { problem: `could not download ${fileName}: ${String(error)}` };
    }
    const safeName = fileName.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_");
    const dir = `.telegram/inbox/${threadId}`;
    const written = await runAsUser(this.deps.config, user, "sh", ["-c", 'umask 077; mkdir -p "$1" && cat > "$1/$2"', "sh", dir, safeName], content);
    return written.code === 0 ? { path: `${homeOf(this.deps.config, user)}/${dir}/${safeName}` } : { problem: `could not save ${fileName}: ${written.stderr.trim()}` };
  }

  private async bind(user: UserConfig, threadId: number, cwd: string, title: string, held: UserInput[]): Promise<void> {
    this.deps.store.addTopic({ userId: user.telegramId, threadId, cwd, sessionId: randomUUID(), title, nextMode: "plan", closed: false });
    const session = this.session(user, threadId);
    if (session === undefined) return;
    await session.createCard();
    if (held.length > 0) {
      await session.submit({
        text: held.map((input) => input.text).filter((t) => t !== "").join("\n\n"),
        images: held.flatMap((input) => input.images ?? []),
        messageId: held[0]?.messageId,
      });
    } else {
      // nothing held: the user writes the task next
    }
  }

  private session(user: UserConfig, threadId: number): TopicSession | undefined {
    const key = `${user.telegramId}:${threadId}`;
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      return existing;
    } else if (this.deps.store.topic(user.telegramId, threadId) === undefined) {
      return undefined;
    } else {
      const session = new TopicSession(this.deps, user, threadId);
      this.sessions.set(key, session);
      return session;
    }
  }

  private account(user: UserConfig): Account {
    const existing = this.accounts.get(user.telegramId);
    if (existing !== undefined) return existing;
    const account = new Account(
      {
        config: this.deps.config,
        store: this.deps.store,
        tg: this.deps.tg,
        log: this.deps.log,
        sessionsRunning: (userId) => this.deps.store.topics(userId).filter((t) => this.sessions.get(`${userId}:${t.threadId}`)?.isRunning === true).length,
        sessionsSummary: (userId) =>
          this.deps.store
            .topics(userId)
            .filter((t) => !t.closed)
            .map((t) => `• ${escapeHtml(displayDir(t.cwd, this.deps.config, user))} — ${this.sessions.get(`${userId}:${t.threadId}`)?.isRunning === true ? "running" : "idle"}`),
        restartUser: (userId) => this.deps.pool.restartUser(userId),
        startLogin: (u, args, callbacks) => this.deps.startLogin(u, args, callbacks),
      },
      user,
    );
    this.accounts.set(user.telegramId, account);
    return account;
  }

  private async reply(user: UserConfig, threadId: number | undefined, html: string): Promise<void> {
    await this.deps.tg
      .sendMessage(user.telegramId, html, { message_thread_id: threadId, parse_mode: "HTML", link_preview_options: { is_disabled: true } })
      .catch((error: unknown) => this.deps.log(`${user.name}: reply: ${String(error)}`));
  }
}

/** `/name@bot args` → { name, args }; undefined for other text. */
export function parseCommand(text: string | undefined): { name: string; args: string } | undefined {
  const match = text?.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match !== null && match !== undefined ? { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() } : undefined;
}
