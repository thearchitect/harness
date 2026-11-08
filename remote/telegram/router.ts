/**
 * Telegram updates → workbench operations, each in its user's queue.
 *
 * - Private chats of configured users, and groups: a configured user adds the
 *   bot (my_chat_member) and owns the workspace; anyone else's addition makes
 *   the bot leave. In a workspace only its owner's messages count.
 * - A message goes to the workspace's agent ("!" builds), or gets "No agent
 *   here." (a link to the Mini App).
 * - Commands (Menu): /new [path], /stop, /detach, /close, /sessions, /model,
 *   /thinking, /login, /secrets, /key. Any other /command goes to the agent
 *   (extension commands).
 * - Buttons: Stop `x:<agent>`, Attach here `t:<agent>`, dialogs
 *   `d:<agent>:<seq>:<action>`, agent panel `s:…`, account `a:…`, login
 *   choices `l:<index>`.
 */

import type { Chat, ChatMemberUpdated, Message, Update } from "grammy/types";
import { homeOf, runAsUser } from "../accounts.ts";
import type { UserConfig } from "../config.ts";
import type { UserInput } from "../core/agent.ts";
import { NO_AGENT, type Workbench } from "../workbench.ts";
import { escapeHtml, link } from "./render.ts";

export type RouterDeps = {
  workbench: Workbench;
  log(line: string): void;
  /** Downloads a file the user sent (Bot API getFile + file URL). */
  download(fileId: string): Promise<Buffer>;
  /** Every accepted update (idle shutdown). */
  activity(): void;
};

/** Telegram's limit for files a bot may download. */
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export const BOT_COMMANDS = [
  { command: "new", description: "New agent here: /new [path]" },
  { command: "stop", description: "Stop the run" },
  { command: "detach", description: "Agent to the background" },
  { command: "close", description: "End the agent" },
  { command: "sessions", description: "Agents and sessions" },
  { command: "model", description: "Model" },
  { command: "thinking", description: "Thinking level" },
  { command: "login", description: "Log in to a provider" },
  { command: "secrets", description: "Secrets" },
  { command: "key", description: "Server SSH key" },
];

const ACCOUNT_COMMANDS = new Set(["login", "secrets", "key"]);

export class Router {
  private readonly deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  private get wb(): Workbench {
    return this.deps.workbench;
  }

  /** Accepts an update; resolves when it has been handled (in order with the user's earlier operations). */
  onUpdate(update: Update): Promise<void> {
    const member = update.my_chat_member;
    const message = update.message ?? update.edited_message;
    const query = update.callback_query;
    const from = member?.from ?? message?.from ?? query?.from;
    const user = from !== undefined ? this.wb.user(from.id) : undefined;
    if (member !== undefined && member.chat.type !== "private") {
      // anyone's adding of the bot matters: a stranger's makes it leave
      return this.serialFor(member.from.id, () => this.onMembership(member, user));
    } else if (user === undefined) {
      this.deps.log(`ignored update ${update.update_id} from ${from?.id ?? "?"} (${(from as { username?: string } | undefined)?.username ?? "no username"})`);
      return Promise.resolve();
    } else {
      this.deps.activity();
      return this.wb.serial(user.telegramId, () => this.route(user, update)).catch((error: unknown) => {
        this.deps.log(`${user.name}: update ${update.update_id} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      });
    }
  }

  /* ------------------------------------------------------------------------ */

  private serialFor(userId: number, step: () => Promise<void>): Promise<void> {
    return this.wb.serial(userId, step).catch((error: unknown) => this.deps.log(`membership update failed: ${String(error)}`));
  }

  private async onMembership(member: ChatMemberUpdated, user: UserConfig | undefined): Promise<void> {
    const chatId = member.chat.id;
    const status = member.new_chat_member.status;
    const present = status === "member" || status === "administrator" || status === "restricted";
    const workspace = this.wb.workspace(chatId);
    if (!present) {
      await this.wb.removeWorkspace(chatId);
    } else if (workspace !== undefined && status !== "administrator") {
      await this.wb.adminHint(chatId);
    } else if (workspace !== undefined) {
      // promoted to admin in a workspace
    } else if (user === undefined) {
      this.deps.log(`added to ${chatId} by ${member.from.id}, who is not configured: leaving`);
      await this.wb.leave(chatId);
    } else {
      await this.wb.addGroup(chatId, titleOf(member.chat), user, status === "administrator", true);
    }
  }

  private async route(user: UserConfig, update: Update): Promise<void> {
    if (update.message !== undefined) {
      await this.onMessage(user, update.message);
    } else if (update.callback_query !== undefined) {
      const query = update.callback_query;
      const chatId = query.message?.chat.id;
      const toast = chatId !== undefined ? await this.onButton(user, chatId, query.message?.message_id, query.data ?? "") : "Unknown chat";
      await this.wb.answer(query.id, toast);
    } else if (update.edited_message !== undefined) {
      const chatId = update.edited_message.chat.id;
      if (this.wb.ownsWorkspace(user, chatId)) await this.wb.outbox(chatId).send({ html: "Edits are not applied; send a new message." });
    } else {
      // other update kinds are not used
    }
  }

  private async onMessage(user: UserConfig, message: Message): Promise<void> {
    const chatId = message.chat.id;
    if (message.chat.type === "private") {
      this.wb.ensurePrivate(user);
    } else if (message.migrate_to_chat_id !== undefined) {
      await this.wb.migrate(chatId, message.migrate_to_chat_id);
      return;
    } else {
      // a group the bot was in before its workspace was known: adopted silently
      await this.wb.addGroup(chatId, titleOf(message.chat), user, undefined, false);
      this.wb.retitle(chatId, titleOf(message.chat));
    }
    if (!this.wb.ownsWorkspace(user, chatId)) {
      return; // someone else's workspace: only its owner counts
    }
    const text = message.text ?? message.caption;
    if (text === undefined && message.photo === undefined && message.document === undefined) {
      return; // service messages and unsupported content
    }
    const outbox = this.wb.outbox(chatId);
    const account = this.wb.account(user);
    const command = parseCommand(message.text);
    const agent = this.wb.agents.attached(chatId);
    if (account.awaitsText(outbox) && command?.name !== "stop") {
      await outbox.userPosted();
      await account.text(text ?? "", message.message_id);
    } else if (command === undefined) {
      const input = await this.input(user, chatId, message, text ?? "");
      if (input !== undefined) {
        await outbox.userPosted();
        await this.wb.prompt(user, chatId, input);
      }
    } else if (ACCOUNT_COMMANDS.has(command.name)) {
      await account.command(command.name, outbox);
    } else {
      switch (command.name) {
        case "start":
          return; // Telegram's first-contact command: nothing to answer
        case "new":
          if (command.args === "") {
            await outbox.send({ markdown: link("Choose a directory…", this.wb.link(chatId, "new")) });
          } else {
            await this.report(chatId, await this.wb.newAgent(user, chatId, command.args));
          }
          return;
        case "sessions":
          await outbox.send({ markdown: link("Agents and sessions", this.wb.link(chatId, "sessions")) });
          return;
        case "stop":
          if (agent !== undefined) {
            await this.wb.stopAgent(user, agent.sessionId);
          } else {
            await account.stop();
          }
          return;
        case "detach":
          await this.report(chatId, await this.wb.detach(user, chatId));
          return;
        case "close":
          await this.report(chatId, await this.wb.askClose(user, chatId));
          return;
        case "model":
        case "thinking":
          if (agent === undefined) {
            await this.wb.noAgent(chatId);
          } else {
            const value = command.name === "model" ? agent.currentModel : agent.currentThinking;
            const label = `${command.name === "model" ? "Model" : "Thinking"}: ${value ?? "not started"}`;
            await outbox.send({ markdown: link(label, this.wb.link(chatId, command.name)) });
          }
          return;
        default: {
          // an extension command of pi
          const input = await this.input(user, chatId, message, text ?? "");
          if (input !== undefined) await this.wb.prompt(user, chatId, input);
          return;
        }
      }
    }
  }

  private async onButton(user: UserConfig, chatId: number, messageId: number | undefined, data: string): Promise<string> {
    const [kind = "", ...rest] = data.split(":");
    const outbox = this.wb.outbox(chatId);
    switch (kind) {
      case "x":
        return (await this.wb.stopAgent(user, rest[0] ?? "")).ok ? "Stopping" : "This agent is gone";
      case "t": {
        const result = await this.wb.attach(user, chatId, rest[0] ?? "");
        return result.ok ? "Attached" : result.problem;
      }
      case "d":
        return this.wb.pressDialog(user, rest[0] ?? "", Number(rest[1]), rest[2] ?? "");
      case "l":
        return this.wb.account(user).loginChoice(Number(rest[0]));
      case "a":
      case "s":
        if (!outbox.ownsPanel(messageId)) {
          return "This panel is closed.";
        } else if (kind === "a") {
          return this.wb.account(user).panelAction(rest[0] ?? "", rest[1], outbox);
        } else if (rest[0] === "closeyes") {
          const agent = this.wb.agents.attached(chatId);
          await outbox.closePanel(undefined);
          return agent !== undefined && (await this.wb.close(user, agent.sessionId)).ok ? "Closed" : NO_AGENT;
        } else {
          await outbox.closePanel(undefined);
          return "OK";
        }
      default:
        return "Unknown button";
    }
  }

  private async report(chatId: number, result: { ok: true } | { ok: false; problem: string }): Promise<void> {
    if (result.ok) {
      // the operation told the chat itself
    } else if (result.problem === NO_AGENT) {
      await this.wb.noAgent(chatId);
    } else {
      await this.wb.outbox(chatId).send({ html: escapeHtml(result.problem) }, { silent: false });
    }
  }

  /** The message as a prompt input: text, photos as images, documents saved to the inbox. */
  private async input(user: UserConfig, chatId: number, message: Message, text: string): Promise<UserInput | undefined> {
    const outbox = this.wb.outbox(chatId);
    let body = text;
    const reply = message.reply_to_message;
    if (reply !== undefined && reply.from?.is_bot === true) {
      const quoted = (reply.text ?? reply.caption ?? "").slice(0, 500);
      if (quoted !== "") body = `${body}\n\n[in reply to: ${quoted}]`;
    } else {
      // not a reply to the bot
    }
    const images: { data: string; mimeType: string }[] = [];
    if (message.photo !== undefined && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      if (largest !== undefined) {
        try {
          images.push({ data: (await this.deps.download(largest.file_id)).toString("base64"), mimeType: "image/jpeg" });
        } catch (error) {
          await outbox.send({ html: `Could not download the photo: ${escapeHtml(String(error))}` }, { silent: false });
          return undefined;
        }
      }
    } else if (message.document !== undefined) {
      const doc = message.document;
      if ((doc.file_size ?? 0) > DOWNLOAD_LIMIT) {
        await outbox.send({ html: "Files over 20 MB cannot be received through Telegram." }, { silent: false });
        return undefined;
      }
      const saved = await this.saveDocument(user, chatId, doc.file_id, doc.file_name ?? `file-${message.message_id}`);
      if ("problem" in saved) {
        await outbox.send({ html: escapeHtml(saved.problem) }, { silent: false });
        return undefined;
      }
      body = `${body}\n\n[attached file: ${saved.path}]`.trim();
    } else {
      // text only
    }
    return { text: body, images: images.length > 0 ? images : undefined };
  }

  private async saveDocument(user: UserConfig, chatId: number, fileId: string, fileName: string): Promise<{ path: string } | { problem: string }> {
    let content: Buffer;
    try {
      content = await this.deps.download(fileId);
    } catch (error) {
      return { problem: `could not download ${fileName}: ${String(error)}` };
    }
    const config = this.wb.config;
    const safeName = fileName.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_");
    const dir = `.telegram/inbox/${chatId}`;
    const written = await runAsUser(config, user, "sh", ["-c", 'umask 077; mkdir -p "$1" && cat > "$1/$2"', "sh", dir, safeName], content);
    return written.code === 0 ? { path: `${homeOf(config, user)}/${dir}/${safeName}` } : { problem: `could not save ${fileName}: ${written.stderr.trim()}` };
  }
}

function titleOf(chat: Chat): string {
  return "title" in chat && typeof chat.title === "string" ? chat.title : "Direct";
}

/** `/name@bot args` → { name, args }; undefined for other text. */
export function parseCommand(text: string | undefined): { name: string; args: string } | undefined {
  const match = text?.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match !== null && match !== undefined ? { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() } : undefined;
}
