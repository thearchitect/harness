/**
 * Telegram updates → workbench operations, each in its user's queue.
 *
 * - Private chats of configured users, and groups: a configured user adds the
 *   bot (my_chat_member) and owns the workspace; anyone else's addition makes
 *   the bot leave. In a workspace only its owner's messages count.
 * - A message goes to the workspace's agent ("!" builds) with its files
 *   (inputs.ts), or gets "No agent here." (a link to the Mini App).
 * - Commands (Menu): /new [path], /status, /stop, /diff, /detach, /close,
 *   /sessions, /model, /thinking, /login, /secrets, /key; /logs for admins;
 *   /start answers with the status. Any other /command goes to the agent
 *   (extension commands).
 * - Buttons: Stop `x:<agent>`, Attach here `t:<agent>`, dialogs
 *   `d:<agent>:<seq>:<action>`, agent panel `s:…`, account `a:…`, login
 *   choices `l:<index>`.
 * - The service message about a message the bot pinned is deleted.
 */

import type { Chat, ChatMemberUpdated, Message, Update } from "grammy/types";
import type { UserConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import type { Event, Telemetry } from "../telemetry.ts";
import { NO_AGENT, type Workbench } from "../workbench.ts";
import { hasInput, Inputs } from "./inputs.ts";
import { escapeHtml, link } from "./render.ts";

export type RouterDeps = {
  workbench: Workbench;
  clock: Clock;
  t: Telemetry;
  /** Downloads a file the user sent (Bot API getFile + file URL). */
  download(fileId: string): Promise<Buffer>;
  /** The journal of the last `hours` (admins' /logs). */
  journal(fromMs: number, toMs: number): Event[];
  /** Every accepted update (idle shutdown). */
  activity(): void;
};

export const BOT_COMMANDS = [
  { command: "new", description: "New agent here: /new [path]" },
  { command: "status", description: "Status" },
  { command: "stop", description: "Stop the run" },
  { command: "diff", description: "Changes in the agent's directory" },
  { command: "detach", description: "Agent to the background" },
  { command: "close", description: "End the agent" },
  { command: "sessions", description: "Agents and sessions" },
  { command: "model", description: "Model" },
  { command: "thinking", description: "Thinking level" },
  { command: "login", description: "Log in to a provider" },
  { command: "secrets", description: "Secrets" },
  { command: "key", description: "Server SSH key" },
];

/** The admins' menu: the commands above and /logs. */
export const ADMIN_COMMANDS = [...BOT_COMMANDS, { command: "logs", description: "Gateway journal: /logs [hours]" }];

/**
 * What an update left running outside the user's queue (a prompt being
 * prepared). Wrapped: an async function returning a bare promise would adopt
 * it and hold the queue.
 */
type Pending = { pending: Promise<void> } | undefined;

const ACCOUNT_COMMANDS = new Set(["login", "secrets", "key"]);
const LOGS_DEFAULT_HOURS = 24;

export class Router {
  private readonly deps: RouterDeps;
  private readonly inputs: Inputs;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.inputs = new Inputs({ workbench: deps.workbench, clock: deps.clock, t: deps.t, download: deps.download });
  }

  private get wb(): Workbench {
    return this.deps.workbench;
  }

  /**
   * Accepts an update; resolves when it has been handled, a message to an
   * agent once its prompt has been submitted (files and voice are prepared
   * outside the user's queue).
   */
  async onUpdate(update: Update): Promise<void> {
    const member = update.my_chat_member;
    const message = update.message ?? update.edited_message;
    const query = update.callback_query;
    const from = member?.from ?? message?.from ?? query?.from;
    const user = from !== undefined ? this.wb.user(from.id) : undefined;
    if (message?.pinned_message !== undefined) {
      await this.onPinned(message);
    } else if (member !== undefined && member.chat.type !== "private") {
      // anyone's adding of the bot matters: a stranger's makes it leave
      await this.wb.serial(member.from.id, () => this.onMembership(member, user)).catch((error: unknown) => this.failed(update, error));
    } else if (user === undefined) {
      this.deps.t.warn("update.stranger", { from: from?.id, username: (from as { username?: string } | undefined)?.username, chat: message?.chat.id ?? query?.message?.chat.id });
    } else {
      this.deps.activity();
      this.deps.t.info("update", { user: user.name, chat: message?.chat.id ?? query?.message?.chat.id, type: kindOf(update), command: parseCommand(message?.text)?.name });
      const handled = await this.wb.serial(user.telegramId, () => this.route(user, update)).catch((error: unknown) => {
        this.failed(update, error);
        return undefined;
      });
      await handled?.pending;
    }
  }

  /* ------------------------------------------------------------------------ */

  private failed(update: Update, error: unknown): void {
    this.deps.t.error("update.failed", { update: update.update_id, type: kindOf(update), message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }

  /** Telegram's "pinned a message" line about the bot's own pin is noise: deleted. */
  private async onPinned(message: Message): Promise<void> {
    const outbox = this.wb.outbox(message.chat.id);
    const pinned = message.pinned_message;
    if (pinned !== undefined && message.from?.is_bot === true && outbox.isOwnPin(pinned.message_id)) {
      await outbox.delete(message.message_id);
    } else {
      // someone else's pin: left alone
    }
  }

  private async onMembership(member: ChatMemberUpdated, user: UserConfig | undefined): Promise<void> {
    const chatId = member.chat.id;
    const status = member.new_chat_member.status;
    const present = status === "member" || status === "administrator" || status === "restricted";
    const workspace = this.wb.workspace(chatId);
    this.deps.t.info("workspace.membership", { chat: chatId, by: member.from.id, status });
    if (!present) {
      await this.wb.removeWorkspace(chatId);
    } else if (workspace !== undefined && status !== "administrator") {
      await this.wb.adminHint(chatId);
    } else if (workspace !== undefined) {
      // promoted to admin in a workspace
    } else if (user === undefined) {
      this.deps.t.warn("workspace.stranger", { chat: chatId, by: member.from.id, message: "added by someone not configured: leaving" });
      await this.wb.leave(chatId);
    } else {
      await this.wb.addGroup(chatId, titleOf(member.chat), user, status === "administrator", true);
    }
  }

  /** Handles the update in the user's queue; resolves with what is still pending outside it (a prompt being prepared). */
  private async route(user: UserConfig, update: Update): Promise<Pending> {
    if (update.message !== undefined) {
      return this.onMessage(user, update.message);
    } else if (update.callback_query !== undefined) {
      const query = update.callback_query;
      const chatId = query.message?.chat.id;
      const toast = chatId !== undefined ? await this.onButton(user, chatId, query.message?.message_id, query.data ?? "") : "Unknown chat";
      await this.wb.answer(query.id, toast);
      return undefined;
    } else if (update.edited_message !== undefined) {
      const chatId = update.edited_message.chat.id;
      if (this.wb.ownsWorkspace(user, chatId)) await this.wb.outbox(chatId).send({ html: "Edits are not applied; send a new message." });
      return undefined;
    } else {
      return undefined; // other update kinds are not used
    }
  }

  private async onMessage(user: UserConfig, message: Message): Promise<Pending> {
    const chatId = message.chat.id;
    if (message.chat.type === "private") {
      this.wb.ensurePrivate(user);
    } else if (message.migrate_to_chat_id !== undefined) {
      await this.wb.migrate(chatId, message.migrate_to_chat_id);
      return undefined;
    } else {
      // a group the bot was in before its workspace was known: adopted silently
      await this.wb.addGroup(chatId, titleOf(message.chat), user, undefined, false);
      this.wb.retitle(chatId, titleOf(message.chat));
    }
    if (!this.wb.ownsWorkspace(user, chatId) || !hasInput(message)) {
      return undefined; // someone else's workspace, or a service message
    }
    const outbox = this.wb.outbox(chatId);
    const account = this.wb.account(user);
    const command = parseCommand(message.text);
    const agent = this.wb.agents.attached(chatId);
    if (account.awaitsText(outbox) && command?.name !== "stop") {
      await outbox.userPosted();
      await account.text(message.text ?? message.caption ?? "", message.message_id);
      return undefined;
    } else if (command === undefined) {
      await outbox.userPosted();
      return this.toAgent(user, message);
    } else if (ACCOUNT_COMMANDS.has(command.name)) {
      await account.command(command.name, outbox);
      return undefined;
    } else {
      switch (command.name) {
        case "start":
        case "status":
          await this.wb.status(user, chatId);
          return undefined;
        case "new":
          if (command.args === "") {
            await outbox.send({ markdown: link("Choose a directory…", this.wb.link(chatId, "files")) });
          } else {
            await this.report(chatId, await this.wb.newAgent(user, chatId, command.args));
          }
          return undefined;
        case "sessions":
          await outbox.send({ markdown: link("Agents and sessions", this.wb.link(chatId, "sessions")) });
          return undefined;
        case "stop":
          if (agent !== undefined) {
            await this.wb.stopAgent(user, agent.sessionId);
          } else {
            await account.stop();
          }
          return undefined;
        case "diff":
          await this.report(chatId, await this.wb.diff(user, chatId));
          return undefined;
        case "detach":
          await this.report(chatId, await this.wb.detach(user, chatId));
          return undefined;
        case "close":
          await this.report(chatId, await this.wb.askClose(user, chatId));
          return undefined;
        case "model":
        case "thinking":
          if (agent === undefined) {
            await this.wb.noAgent(chatId);
          } else {
            const value = command.name === "model" ? agent.currentModel : agent.currentThinking;
            const label = `${command.name === "model" ? "Model" : "Thinking"}: ${value ?? "not started"}`;
            await outbox.send({ markdown: link(label, this.wb.link(chatId, "here")) });
          }
          return undefined;
        case "logs":
          if (user.admin) {
            await this.logs(chatId, command.args);
            return undefined;
          } else {
            return this.toAgent(user, message); // not a gateway command for this user
          }
        default:
          return this.toAgent(user, message); // an extension command of pi
      }
    }
  }

  /** A message for the workspace's agent: prepared outside the queue (files, voice), then prompted in order. */
  private toAgent(user: UserConfig, message: Message): Pending {
    return { pending: this.inputs.add(user, message) };
  }

  /** `/logs [hours]`: the journal of the last hours as a .jsonl document. */
  private async logs(chatId: number, args: string): Promise<void> {
    const hours = args === "" ? LOGS_DEFAULT_HOURS : Number(args);
    const outbox = this.wb.outbox(chatId);
    if (!Number.isFinite(hours) || hours <= 0) {
      await outbox.send({ html: "Usage: /logs [hours]" });
    } else {
      const to = this.deps.clock.now();
      const from = to - hours * 3_600_000;
      const events = this.deps.journal(from, to);
      const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, "");
      const body = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""));
      await outbox.sendDocument({ name: `gateway-${stamp(from)}-${stamp(to)}.jsonl`, data: body }, `${events.length} events, ${events.filter((e) => e.level === "error").length} errors`);
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
}

function titleOf(chat: Chat): string {
  return "title" in chat && typeof chat.title === "string" ? chat.title : "Direct";
}

function kindOf(update: Update): string {
  return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}

/** `/name@bot args` → { name, args }; undefined for other text. */
export function parseCommand(text: string | undefined): { name: string; args: string } | undefined {
  const match = text?.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match !== null && match !== undefined ? { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() } : undefined;
}
