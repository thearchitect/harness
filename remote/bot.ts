/**
 * Routing of Telegram updates: only private chats of configured users; per
 * user, updates are handled strictly in order.
 *
 * A place is a topic the user created, or All. It either has no agent (a
 * place for service commands) or runs exactly one, started with /agent and
 * stopped with /close. The bot never creates, renames or deletes topics.
 *
 * - With an agent: a message goes to it ("!" builds), /stop, /model,
 *   /thinking, /compact, /close act on it.
 * - Without one: /agent [path] starts it; any other text gets one line.
 * - Anywhere: /login, /secrets, /key, /sessions.
 *
 * Any other /command goes to the agent's pi (extension commands).
 */

import { randomUUID } from "node:crypto";
import type { Message, Update } from "grammy/types";
import { Account } from "./account.ts";
import { homeOf, runAsUser } from "./accounts.ts";
import { dirsPanel } from "./card.ts";
import type { UserConfig } from "./config.ts";
import { dirChoices, resolveDir } from "./directories.ts";
import type { LoginCallbacks, LoginRun } from "./login.ts";
import { Outbox } from "./outbox.ts";
import { escapeHtml } from "./render.ts";
import { Agent, displayDir, type SessionDeps, type UserInput } from "./session.ts";
import type { Place } from "./state.ts";
import type { Tg } from "./tg.ts";

export type GatewayDeps = SessionDeps & {
  tg: Tg;
  startLogin(user: UserConfig, args: string[], callbacks: LoginCallbacks): LoginRun;
  /** Downloads a file the user sent (Bot API getFile + file URL). */
  download(fileId: string): Promise<Buffer>;
  /** Called for every accepted update (idle shutdown). */
  activity(): void;
};

/** Telegram's limit for files a bot may download. */
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export const BOT_COMMANDS = [
  { command: "agent", description: "Start an agent here: /agent [path]" },
  { command: "stop", description: "Stop the run" },
  { command: "model", description: "Model" },
  { command: "thinking", description: "Thinking level" },
  { command: "compact", description: "Compact the context" },
  { command: "close", description: "Close the agent" },
  { command: "login", description: "Log in to a provider" },
  { command: "secrets", description: "Secrets" },
  { command: "key", description: "Server SSH key" },
  { command: "sessions", description: "Running agents" },
];

const ACCOUNT_COMMANDS = new Set(["login", "secrets", "key", "sessions"]);
const AGENT_COMMANDS = new Set(["stop", "model", "thinking", "compact", "close"]);
const NO_AGENT = "No agent here. /agent [path] starts one.";

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly users = new Map<number, UserConfig>();
  private readonly agents = new Map<string, Agent>();
  private readonly places = new Map<string, Outbox>();
  private readonly accounts = new Map<number, Account>();
  /** The directories the open /agent panel of a place offers. */
  private readonly dirOffers = new Map<string, string[]>();
  private readonly chains = new Map<number, Promise<void>>();

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    for (const user of deps.config.users) this.users.set(user.telegramId, user);
  }

  /** Nothing runs or waits for the user anywhere. */
  isQuiescent(): boolean {
    return this.deps.pool.isQuiescent() && [...this.agents.values()].every((a) => a.quiescent) && [...this.accounts.values()].every((a) => a.quiescent);
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
    await Promise.all([...this.agents.values()].map((a) => a.shutdown()));
    await this.deps.pool.stopAll();
    await Promise.all([...this.places.values()].map((p) => p.flush()));
  }

  /* ------------------------------------------------------------------------ */

  private async route(user: UserConfig, update: Update): Promise<void> {
    if (update.message !== undefined) {
      await this.onMessage(user, update.message);
    } else if (update.callback_query !== undefined) {
      const query = update.callback_query;
      const message = query.message;
      const place = message?.is_topic_message === true ? message.message_thread_id : undefined;
      const toast = await this.onButton(user, place, message?.message_id, query.data ?? "");
      await this.deps.tg.answerCallbackQuery(query.id, { text: toast.slice(0, 200) }).catch((error: unknown) => this.deps.log(`answerCallbackQuery: ${String(error)}`));
    } else if (update.stopped_message_generation !== undefined) {
      await this.agent(user, update.stopped_message_generation.message_thread_id)?.stop();
    } else if (update.edited_message !== undefined) {
      const edited = update.edited_message;
      await this.place(user, edited.is_topic_message === true ? edited.message_thread_id : undefined).send({ html: "Edits are not applied; send a new message." });
    } else {
      // other update kinds are not used
    }
  }

  private async onMessage(user: UserConfig, message: Message): Promise<void> {
    const placeId: Place = message.is_topic_message === true ? message.message_thread_id : undefined;
    const text = message.text ?? message.caption;
    if (text === undefined && message.photo === undefined && message.document === undefined) {
      return; // service messages (topic created, pins) and unsupported content
    }
    const place = this.place(user, placeId);
    const command = parseCommand(message.text);
    const account = this.account(user);
    const agent = this.agent(user, placeId);

    if (account.awaitsText(place) && command?.name !== "stop") {
      await place.userPosted();
      await account.text(text ?? "", message.message_id);
    } else if (command !== undefined && ACCOUNT_COMMANDS.has(command.name)) {
      await account.command(command.name, place);
    } else if (command?.name === "agent") {
      await this.startAgent(user, placeId, command.args);
    } else if (command?.name === "start") {
      return; // Telegram's first-contact command: nothing to answer
    } else if (agent === undefined) {
      if (command?.name === "stop") {
        await account.stop();
      } else {
        await place.send({ html: NO_AGENT });
      }
    } else if (command !== undefined && AGENT_COMMANDS.has(command.name)) {
      await this.agentCommand(agent, command.name);
    } else {
      const input = await this.input(user, placeId, message, text ?? "");
      if (input !== undefined) await agent.userInput(input);
    }
  }

  private async agentCommand(agent: Agent, name: string): Promise<void> {
    switch (name) {
      case "stop":
        await agent.stop();
        return;
      case "model":
        await agent.panelAction("models", "0");
        return;
      case "thinking":
      case "compact":
      case "close":
        await agent.panelAction(name, undefined);
        return;
      default:
        throw new Error(`not an agent command: /${name}`);
    }
  }

  /** /agent [path]: with a path, starts at once; without, offers directories. */
  private async startAgent(user: UserConfig, placeId: Place, path: string): Promise<void> {
    const place = this.place(user, placeId);
    const existing = this.agent(user, placeId);
    if (existing !== undefined) {
      await place.send({ html: `An agent is already running here (${escapeHtml(existing.dir)}). /close first.` });
    } else if (path !== "") {
      const chosen = resolveDir(this.deps.config, user, path);
      if ("problem" in chosen) {
        await place.send({ html: escapeHtml(chosen.problem) }, { silent: false });
      } else {
        await this.bind(user, placeId, chosen.dir);
      }
    } else {
      const dirs = dirChoices(this.deps.config, this.deps.store, user, this.deps.log);
      this.dirOffers.set(placeKey(user, placeId), dirs);
      await place.showPanel(dirsPanel(dirs.map((dir) => displayDir(dir, this.deps.config, user))));
    }
  }

  private async bind(user: UserConfig, placeId: Place, cwd: string): Promise<void> {
    this.deps.store.addAgent({ userId: user.telegramId, threadId: placeId, cwd, sessionId: randomUUID() });
    this.deps.store.rememberDir(user.telegramId, cwd);
    const agent = this.agent(user, placeId);
    if (agent !== undefined) {
      await agent.open();
    } else {
      throw new Error("the agent just added is missing");
    }
  }

  private async onButton(user: UserConfig, placeId: Place, messageId: number | undefined, data: string): Promise<string> {
    const [kind, action = "", arg] = data.split(":");
    const place = this.place(user, placeId);
    const agent = this.agent(user, placeId);
    if (kind === "a" || kind === "s" || kind === "p") {
      if (!place.ownsPanel(messageId)) {
        return "This panel is closed.";
      } else if (kind === "a") {
        return this.account(user).panelAction(action, arg, place);
      } else if (kind === "p") {
        return this.pickDir(user, placeId, Number(action));
      } else if (agent !== undefined) {
        return agent.panelAction(action, arg);
      } else {
        await place.closePanel(undefined);
        return "OK";
      }
    } else if (kind === "l") {
      return this.account(user).loginChoice(Number(action));
    } else if (kind === "d") {
      return agent !== undefined ? agent.dialogButton(Number(action), arg ?? "") : "This agent is gone.";
    } else {
      return "Unknown button";
    }
  }

  private async pickDir(user: UserConfig, placeId: Place, index: number): Promise<string> {
    const place = this.place(user, placeId);
    const dir = this.dirOffers.get(placeKey(user, placeId))?.[index];
    this.dirOffers.delete(placeKey(user, placeId));
    if (dir === undefined) {
      await place.closePanel("The list is outdated, run /agent again.");
      return "Failed";
    } else if (this.agent(user, placeId) !== undefined) {
      await place.closePanel("An agent is already running here.");
      return "Failed";
    } else {
      const shown = displayDir(dir, this.deps.config, user);
      await place.closePanel(`Agent in ${escapeHtml(shown)}.`);
      await this.bind(user, placeId, dir);
      return shown;
    }
  }

  /** The message as a prompt input: text, photos as images, documents saved to the inbox. */
  private async input(user: UserConfig, placeId: Place, message: Message, text: string): Promise<UserInput | undefined> {
    const place = this.place(user, placeId);
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
          await place.send({ html: `Could not download the photo: ${escapeHtml(String(error))}` }, { silent: false });
          return undefined;
        }
      }
    } else if (message.document !== undefined) {
      const doc = message.document;
      if ((doc.file_size ?? 0) > DOWNLOAD_LIMIT) {
        await place.send({ html: "Files over 20 MB cannot be received through Telegram." }, { silent: false });
        return undefined;
      }
      const saved = await this.saveDocument(user, placeId, doc.file_id, doc.file_name ?? `file-${message.message_id}`);
      if ("problem" in saved) {
        await place.send({ html: escapeHtml(saved.problem) }, { silent: false });
        return undefined;
      }
      body = `${body}\n\n[attached file: ${saved.path}]`.trim();
    } else {
      // text only
    }
    return { text: body, images: images.length > 0 ? images : undefined };
  }

  private async saveDocument(user: UserConfig, placeId: Place, fileId: string, fileName: string): Promise<{ path: string } | { problem: string }> {
    let content: Buffer;
    try {
      content = await this.deps.download(fileId);
    } catch (error) {
      return { problem: `could not download ${fileName}: ${String(error)}` };
    }
    const safeName = fileName.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_");
    const dir = `.telegram/inbox/${placeId ?? "all"}`;
    const written = await runAsUser(this.deps.config, user, "sh", ["-c", 'umask 077; mkdir -p "$1" && cat > "$1/$2"', "sh", dir, safeName], content);
    return written.code === 0 ? { path: `${homeOf(this.deps.config, user)}/${dir}/${safeName}` } : { problem: `could not save ${fileName}: ${written.stderr.trim()}` };
  }

  /** The outbox of a place: one per place, shared by everything that posts there. */
  private place(user: UserConfig, placeId: Place): Outbox {
    const key = placeKey(user, placeId);
    const existing = this.places.get(key);
    if (existing !== undefined) {
      return existing;
    } else {
      const outbox = new Outbox(this.deps.tg, user.telegramId, placeId, (line) => this.deps.log(`${user.name}/${placeId ?? "all"}: ${line}`), () => {
        // the user deleted the topic: its agent goes
        void this.agents.get(key)?.placeGone();
        this.agents.delete(key);
        this.places.delete(key);
      });
      this.places.set(key, outbox);
      return outbox;
    }
  }

  /** The agent of a place, if it has one. */
  private agent(user: UserConfig, placeId: Place): Agent | undefined {
    const key = placeKey(user, placeId);
    if (this.deps.store.agent(user.telegramId, placeId) === undefined) {
      this.agents.delete(key); // closed
      return undefined;
    } else {
      const existing = this.agents.get(key);
      if (existing !== undefined) {
        return existing;
      } else {
        const agent = new Agent(this.deps, user, placeId, this.place(user, placeId));
        this.agents.set(key, agent);
        return agent;
      }
    }
  }

  private account(user: UserConfig): Account {
    const existing = this.accounts.get(user.telegramId);
    if (existing !== undefined) return existing;
    const account = new Account(
      {
        config: this.deps.config,
        clock: this.deps.clock,
        log: this.deps.log,
        sessionsSummary: (userId) =>
          this.deps.store
            .agents(userId)
            .map((a) => `${escapeHtml(displayDir(a.cwd, this.deps.config, user))}: ${this.agents.get(placeKey(user, a.threadId))?.isRunning === true ? "running" : "idle"}`),
        restartUser: (userId) => this.deps.pool.restartUser(userId),
        startLogin: (u, args, callbacks) => this.deps.startLogin(u, args, callbacks),
      },
      user,
    );
    this.accounts.set(user.telegramId, account);
    return account;
  }
}

function placeKey(user: UserConfig, placeId: Place): string {
  return `${user.telegramId}:${placeId ?? "all"}`;
}

/** `/name@bot args` → { name, args }; undefined for other text. */
export function parseCommand(text: string | undefined): { name: string; args: string } | undefined {
  const match = text?.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match !== null && match !== undefined ? { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() } : undefined;
}
