/**
 * Everything the gateway sends into one topic (or into All, without a topic),
 * in order, through one queue, and the invariant that keeps buttons
 * reachable: action buttons live only on the last message of the topic.
 *
 * - A transient keyboard (a panel, banner buttons) loses its buttons as soon
 *   as anything else is posted below it, by the bot or by the user; until then
 *   it can be edited in place (panel navigation).
 * - A sticky message (an open dialog, a request for input) is re-sent below
 *   every newer message, so it always stays the last one until it is closed.
 * - Pinned cards are edited in place and never move.
 *
 * Bot API failures are logged; a topic deleted by the user is reported once
 * through onThreadGone.
 */

import type { ForceReply, InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { plainFallback } from "./render.ts";
import { describeError, isNotModified, isParseError, isThreadGone, type Tg } from "./tg.ts";

export type Body = { html: string } | { markdown: string };
export type Keyboard = InlineKeyboardButton[][];
type Markup = InlineKeyboardMarkup | ForceReply;

/** How a sent message takes part in the button invariant. */
export type Role = "plain" | "transient" | "sticky" | "pinned";

export type SendOptions = {
  role?: Role;
  silent?: boolean;
  keyboard?: Keyboard;
  /** Ask for a text reply (sticky messages only). */
  forceReply?: string;
};

type Tracked = { messageId: number; body: Body; markup?: Markup; silent: boolean };

export class Outbox {
  private readonly tg: Tg;
  private readonly chatId: number;
  /** The topic; undefined for All. */
  readonly threadId: number | undefined;
  private readonly log: (line: string) => void;
  private readonly onThreadGone: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private transient: Tracked | undefined;
  private sticky: Tracked | undefined;
  private panelId: number | undefined;
  private gone = false;

  constructor(tg: Tg, chatId: number, threadId: number | undefined, log: (line: string) => void, onThreadGone: () => void) {
    this.tg = tg;
    this.chatId = chatId;
    this.threadId = threadId;
    this.log = log;
    this.onThreadGone = onThreadGone;
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

  private async sendNow(body: Body, options: SendOptions): Promise<number | undefined> {
    {
      const role = options.role ?? "plain";
      const markup: Markup | undefined = options.forceReply !== undefined
        ? ({ force_reply: true, input_field_placeholder: options.forceReply } satisfies ForceReply)
        : options.keyboard !== undefined
          ? ({ inline_keyboard: options.keyboard } satisfies InlineKeyboardMarkup)
          : undefined;
      const silent = options.silent ?? true;
      if (role !== "pinned") {
        await this.stripTransient();
      } else {
        // pinned cards do not move anything
      }
      if (role === "sticky" && this.sticky !== undefined) {
        await this.stripMarkup(this.sticky);
        this.sticky = undefined;
      } else {
        // no previous sticky to replace
      }
      const messageId = await this.post(body, markup, silent);
      if (messageId === undefined) {
        return undefined;
      } else {
        const tracked: Tracked = { messageId, body, markup, silent };
        switch (role) {
          case "plain":
          case "pinned":
            break;
          case "transient":
            this.transient = tracked;
            break;
          case "sticky":
            this.sticky = tracked;
            break;
          default:
            assertNever(role);
        }
        if (role !== "sticky" && role !== "pinned") {
          await this.bumpSticky();
        } else {
          // the sticky message itself, or a pinned card: nothing to move
        }
        return messageId;
      }
    }
  }

  /** Replaces the open sticky message's content (and buttons) in place. */
  editSticky(body: Body, keyboard?: Keyboard): Promise<void> {
    return this.enqueue(async () => {
      const sticky = this.sticky;
      if (sticky === undefined) {
        this.log("editSticky without a sticky message");
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
        this.log("closeSticky without a sticky message");
      } else {
        this.sticky = undefined;
        await this.editMessage(sticky.messageId, finalBody, { inline_keyboard: [] });
      }
    });
  }

  /** The user posted into the topic: older buttons go, the open dialog moves below. */
  userPosted(): Promise<void> {
    return this.enqueue(async () => {
      await this.stripTransient();
      await this.bumpSticky();
    });
  }

  /** Removes the buttons of the transient message, if any. */
  dropTransient(): Promise<void> {
    return this.enqueue(() => this.stripTransient());
  }

  /* Panels: the inline choices of a command, the place's
   * transient message. Showing a panel again edits it in place while it is
   * still the last message with buttons; otherwise a new one is posted. */

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

  /** Edits any message in place (pinned cards). */
  edit(messageId: number, body: Body, keyboard?: Keyboard): Promise<void> {
    return this.enqueue(() => this.editMessage(messageId, body, keyboard !== undefined ? { inline_keyboard: keyboard } : { inline_keyboard: [] }));
  }

  delete(messageId: number): Promise<void> {
    return this.enqueue(() => this.call("deleteMessage", () => this.tg.deleteMessage(this.chatId, messageId)).then(() => undefined));
  }

  pin(messageId: number): Promise<void> {
    return this.enqueue(() =>
      this.call("pinChatMessage", () => this.tg.pinChatMessage(this.chatId, messageId, { disable_notification: true })).then(() => undefined),
    );
  }

  unpin(messageId: number): Promise<void> {
    return this.enqueue(() => this.call("unpinChatMessage", () => this.tg.unpinChatMessage(this.chatId, messageId)).then(() => undefined));
  }

  /** The live draft of a run (ephemeral; Telegram keeps it 30 s). */
  draft(draftId: number, markdown: string): Promise<void> {
    return this.enqueue(() =>
      this.call("sendRichMessageDraft", () =>
        this.tg.sendRichMessageDraft(this.chatId, draftId, { markdown }, { message_thread_id: this.threadId, can_stop: true }),
      ).then(() => undefined),
    );
  }

  /* ------------------------------------------------------------------------ */

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

  private async post(body: Body, markup: Markup | undefined, silent: boolean): Promise<number | undefined> {
    const common = { message_thread_id: this.threadId, disable_notification: silent, reply_markup: markup };
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

  private async editMessage(messageId: number, body: Body, markup: Markup | undefined): Promise<void> {
    const reply_markup = markup !== undefined && "inline_keyboard" in markup ? markup : undefined;
    if ("html" in body) {
      await this.call("editMessageText", () =>
        this.tg.editMessageText(this.chatId, messageId, body.html, { parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } }),
      );
    } else {
      await this.call(
        "editMessageText",
        () => this.tg.editMessageText(this.chatId, messageId, { markdown: body.markdown }, { reply_markup }),
        () => this.tg.editMessageText(this.chatId, messageId, plainFallback(body.markdown), { reply_markup }),
      );
    }
  }

  /** Runs a Bot API call; logs failures, retries once with the fallback on a parse error. */
  private async call<T>(what: string, run: () => Promise<T>, fallback?: () => Promise<T>): Promise<T | undefined> {
    if (this.gone) return undefined;
    try {
      return await run();
    } catch (error) {
      if (isNotModified(error)) {
        return undefined;
      } else if (fallback !== undefined && isParseError(error)) {
        this.log(`${what}: ${describeError(error)}; resending as plain text`);
        return this.call(what, fallback);
      } else if (isThreadGone(error)) {
        this.gone = true;
        this.log(`topic ${this.threadId} is gone`);
        this.onThreadGone();
        return undefined;
      } else {
        this.log(`${what} failed: ${describeError(error)}`);
        return undefined;
      }
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected role: ${String(value)}`);
}
