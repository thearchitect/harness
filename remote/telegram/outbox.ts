/**
 * Everything the gateway sends into one chat (a private chat with the bot or
 * a group), in order, through one queue, and the invariant that keeps buttons
 * reachable: action buttons live only on the last message of the chat.
 *
 * - A transient keyboard (a panel) loses its buttons as soon as anything else
 *   is posted below it, by the bot or by the user; until then it can be
 *   edited in place (panel navigation).
 * - A sticky message (an open dialog, a request for input) is re-sent below
 *   every newer message, so it always stays the last one until it is closed.
 * - Plain messages may be edited later (the blocks of a run).
 *
 * Bot API failures are logged; a chat the bot can no longer write to (left,
 * kicked, blocked) is reported once through onChatGone.
 */

import { InputFile } from "grammy";
import type { ForceReply, InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { Telemetry } from "../telemetry.ts";
import { plainFallback } from "./render.ts";
import { describeError, isChatGone, isMessageGone, isNotModified, isParseError, isPinDenied, type Tg } from "./tg.ts";

export type Body = { html: string } | { markdown: string };
export type Keyboard = InlineKeyboardButton[][];
type Markup = InlineKeyboardMarkup | ForceReply;

/** How a sent message takes part in the button invariant. */
export type Role = "plain" | "transient" | "sticky";

export type SendOptions = {
  role?: Role;
  silent?: boolean;
  keyboard?: Keyboard;
  /** Ask for a text reply (sticky messages only). */
  forceReply?: string;
  /** Sent as a reply to this message of the chat. */
  replyTo?: number;
};

/** A file to send: its name in the chat and its content. */
export type OutFile = { name: string; data: Buffer };

type Tracked = { messageId: number; body: Body; markup?: Markup };

export class Outbox {
  readonly chatId: number;
  private readonly tg: Tg;
  private readonly t: Telemetry;
  private readonly pinned = new Set<number>();
  private pinDeniedReported = false;
  /** Called once when the bot may not pin messages here. */
  onPinDenied: () => void = () => undefined;
  private readonly onChatGone: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private transient: Tracked | undefined;
  private sticky: Tracked | undefined;
  private panelId: number | undefined;
  private gone = false;

  constructor(tg: Tg, chatId: number, t: Telemetry, onChatGone: () => void) {
    this.tg = tg;
    this.chatId = chatId;
    this.t = t;
    this.onChatGone = onChatGone;
  }

  /** Resolves when everything enqueued so far has been sent. */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  get hasSticky(): boolean {
    return this.sticky !== undefined;
  }

  /** Sends a message; resolves with its id, or undefined when it could not be sent. */
  send(body: Body, options: SendOptions = {}): Promise<number | undefined> {
    return this.enqueue(() => this.sendNow(body, options));
  }

  /** Replaces the open sticky message's content (and buttons) in place. */
  editSticky(body: Body, keyboard?: Keyboard): Promise<void> {
    return this.enqueue(async () => {
      const sticky = this.sticky;
      if (sticky === undefined) {
        this.t.warn("tg.sticky", { chat: this.chatId, message: "editSticky without a sticky message" });
      } else {
        sticky.body = body;
        sticky.markup = keyboard !== undefined ? { inline_keyboard: keyboard } : sticky.markup;
        await this.editMessage(sticky.messageId, body, sticky.markup);
      }
    });
  }

  /** Closes the sticky message: final content, no buttons. */
  closeSticky(finalBody: Body): Promise<void> {
    return this.enqueue(async () => {
      const sticky = this.sticky;
      if (sticky === undefined) {
        this.t.warn("tg.sticky", { chat: this.chatId, message: "closeSticky without a sticky message" });
      } else {
        this.sticky = undefined;
        await this.editMessage(sticky.messageId, finalBody, { inline_keyboard: [] });
      }
    });
  }

  /** The user posted into the chat: older buttons go, the open dialog moves below. */
  userPosted(): Promise<void> {
    return this.enqueue(async () => {
      await this.stripTransient();
      await this.bumpSticky();
    });
  }

  /* Panels: the inline choices of a command, the chat's transient message.
   * Showing a panel again edits it in place while it is still the last
   * message with buttons; otherwise a new one is posted. */

  /** The pressed message is the live panel. */
  ownsPanel(messageId: number | undefined): boolean {
    return messageId !== undefined && this.panelId === messageId && this.transient?.messageId === messageId;
  }

  showPanel(view: { html: string; keyboard: Keyboard }): Promise<void> {
    return this.enqueue(async () => {
      const live = this.transient !== undefined && this.transient.messageId === this.panelId ? this.transient : undefined;
      if (live !== undefined) {
        live.body = { html: view.html };
        live.markup = { inline_keyboard: view.keyboard };
        await this.editMessage(live.messageId, live.body, live.markup);
      } else {
        this.panelId = await this.sendNow({ html: view.html }, { role: "transient", keyboard: view.keyboard });
      }
    });
  }

  /** The outcome replaces the live panel (no buttons), or is posted when the panel is gone; undefined deletes the panel. */
  closePanel(html: string | undefined): Promise<void> {
    return this.enqueue(async () => {
      const live = this.transient !== undefined && this.transient.messageId === this.panelId ? this.transient : undefined;
      this.panelId = undefined;
      if (live !== undefined) {
        this.transient = undefined;
        if (html !== undefined) {
          await this.editMessage(live.messageId, { html }, { inline_keyboard: [] });
        } else {
          await this.call("deleteMessage", () => this.tg.deleteMessage(this.chatId, live.messageId));
        }
      } else if (html !== undefined) {
        await this.sendNow({ html }, {});
      } else {
        // nothing to delete
      }
    });
  }

  /** Edits a plain message in place (a block of a run): "gone" when the user deleted it. */
  edit(messageId: number, body: Body, keyboard?: Keyboard): Promise<"ok" | "gone"> {
    return this.enqueue(() => this.editMessage(messageId, body, { inline_keyboard: keyboard ?? [] }));
  }

  delete(messageId: number): Promise<void> {
    return this.enqueue(() => this.call("deleteMessage", () => this.tg.deleteMessage(this.chatId, messageId)).then(() => undefined));
  }

  /** Sends a file (a plain message: older buttons go, an open dialog moves below); resolves with its id. */
  sendDocument(file: OutFile, caption: string | undefined, options: { silent?: boolean } = {}): Promise<number | undefined> {
    return this.enqueue(async () => {
      await this.stripTransient();
      const sent = await this.call("sendDocument", () =>
        this.tg.sendDocument(this.chatId, new InputFile(file.data, file.name), {
          ...(caption !== undefined && caption !== "" ? { caption, parse_mode: "HTML" as const } : {}),
          disable_notification: options.silent ?? true,
        }),
      );
      await this.bumpSticky();
      return sent?.message_id;
    });
  }

  /**
   * Pins one of the bot's messages without a notification. The service
   * message Telegram adds about it is recognised by isOwnPin and deleted by
   * the router. Pinning without the right to (a group) is reported once
   * through onPinDenied.
   */
  pin(messageId: number): Promise<void> {
    return this.enqueue(async () => {
      this.pinned.add(messageId);
      try {
        await this.tg.pinChatMessage(this.chatId, messageId, { disable_notification: true });
      } catch (error) {
        this.pinned.delete(messageId);
        if (isPinDenied(error)) {
          this.t.warn("tg.pin_denied", { chat: this.chatId, message: describeError(error) });
          if (!this.pinDeniedReported) {
            this.pinDeniedReported = true;
            this.onPinDenied();
          }
        } else if (isChatGone(error)) {
          this.t.warn("tg.chat_gone", { chat: this.chatId, method: "pinChatMessage", message: describeError(error) });
        } else {
          this.t.error("tg.call", { chat: this.chatId, method: "pinChatMessage", message: describeError(error) });
        }
      }
    });
  }

  /** The pinned message is one the bot pinned itself. */
  isOwnPin(messageId: number): boolean {
    return this.pinned.has(messageId);
  }

  /* ------------------------------------------------------------------------ */

  private async sendNow(body: Body, options: SendOptions): Promise<number | undefined> {
    const role = options.role ?? "plain";
    const markup: Markup | undefined = options.forceReply !== undefined
      ? ({ force_reply: true, input_field_placeholder: options.forceReply } satisfies ForceReply)
      : options.keyboard !== undefined
        ? ({ inline_keyboard: options.keyboard } satisfies InlineKeyboardMarkup)
        : undefined;
    await this.stripTransient();
    if (role === "sticky" && this.sticky !== undefined) {
      await this.stripMarkup(this.sticky);
      this.sticky = undefined;
    } else {
      // no previous sticky to replace
    }
    const messageId = await this.post(body, markup, options.silent ?? true, options.replyTo);
    if (messageId === undefined) {
      return undefined;
    } else {
      const tracked: Tracked = { messageId, body, markup };
      switch (role) {
        case "plain":
          await this.bumpSticky();
          break;
        case "transient":
          this.transient = tracked;
          await this.bumpSticky();
          break;
        case "sticky":
          this.sticky = tracked;
          break;
        default:
          assertNever(role);
      }
      return messageId;
    }
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step, step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async stripTransient(): Promise<void> {
    const transient = this.transient;
    if (transient === undefined) {
      // nothing to strip
    } else {
      this.transient = undefined;
      await this.stripMarkup(transient);
    }
  }

  private async stripMarkup(message: Tracked): Promise<void> {
    if (message.markup !== undefined && "inline_keyboard" in message.markup) {
      await this.call("editMessageReplyMarkup", () =>
        this.tg.editMessageReplyMarkup(this.chatId, message.messageId, { reply_markup: { inline_keyboard: [] } }),
      );
    } else {
      // no inline buttons to remove (plain message or a force-reply prompt)
    }
  }

  /** Re-sends the open sticky message below everything else. */
  private async bumpSticky(): Promise<void> {
    const sticky = this.sticky;
    if (sticky === undefined) {
      // no open dialog
    } else {
      await this.call("deleteMessage", () => this.tg.deleteMessage(this.chatId, sticky.messageId));
      const messageId = await this.post(sticky.body, sticky.markup, true);
      if (messageId !== undefined) {
        sticky.messageId = messageId;
      } else {
        this.sticky = undefined; // could not re-send: the dialog is lost, logged by post()
      }
    }
  }

  private async post(body: Body, markup: Markup | undefined, silent: boolean, replyTo?: number): Promise<number | undefined> {
    const common = {
      disable_notification: silent,
      reply_markup: markup,
      ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    };
    if ("html" in body) {
      const sent = await this.call("sendMessage", () =>
        this.tg.sendMessage(this.chatId, body.html, { ...common, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      );
      return sent?.message_id;
    } else {
      const sent = await this.call(
        "sendRichMessage",
        () => this.tg.sendRichMessage(this.chatId, { markdown: body.markdown }, common),
        () => this.tg.sendRichMessage(this.chatId, plainFallback(body.markdown), common),
      );
      return sent?.message_id;
    }
  }

  private async editMessage(messageId: number, body: Body, markup: Markup | undefined): Promise<"ok" | "gone"> {
    const reply_markup = markup !== undefined && "inline_keyboard" in markup ? markup : undefined;
    let gone = false;
    const onGone = (): void => {
      gone = true;
    };
    if ("html" in body) {
      await this.call(
        "editMessageText",
        () => this.tg.editMessageText(this.chatId, messageId, body.html, { parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } }),
        undefined,
        onGone,
      );
    } else {
      await this.call(
        "editMessageText",
        () => this.tg.editMessageText(this.chatId, messageId, { markdown: body.markdown }, { reply_markup }),
        () => this.tg.editMessageText(this.chatId, messageId, plainFallback(body.markdown), { reply_markup }),
        onGone,
      );
    }
    return gone ? "gone" : "ok";
  }

  /** Runs a Bot API call; logs failures, retries once with the fallback on a parse error. */
  private async call<T>(what: string, run: () => Promise<T>, fallback?: () => Promise<T>, onMessageGone?: () => void): Promise<T | undefined> {
    if (this.gone) return undefined;
    try {
      return await run();
    } catch (error) {
      if (isNotModified(error)) {
        return undefined;
      } else if (fallback !== undefined && isParseError(error)) {
        this.t.warn("tg.parse", { chat: this.chatId, method: what, message: describeError(error) });
        return this.call(what, fallback, undefined, onMessageGone);
      } else if (onMessageGone !== undefined && isMessageGone(error)) {
        onMessageGone();
        return undefined;
      } else if (isChatGone(error)) {
        this.gone = true;
        this.t.warn("tg.chat_gone", { chat: this.chatId, method: what, message: describeError(error) });
        this.onChatGone();
        return undefined;
      } else {
        this.t.error("tg.call", { chat: this.chatId, method: what, message: describeError(error) });
        return undefined;
      }
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected role: ${String(value)}`);
}
