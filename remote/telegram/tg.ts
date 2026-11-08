/**
 * The part of the Bot API the gateway uses (grammY's Api), so tests can pass
 * a recording fake, and the classification of Bot API errors.
 */

import { GrammyError, type Api } from "grammy";

export type Tg = Pick<
  Api,
  | "sendMessage"
  | "editMessageText"
  | "editMessageReplyMarkup"
  | "deleteMessage"
  | "sendRichMessage"
  | "answerCallbackQuery"
  | "leaveChat"
  | "getFile"
  | "sendDocument"
  | "pinChatMessage"
  | "setMyCommands"
>;

/** The bot may not pin messages in this chat (a group without the right). */
export function isPinDenied(error: unknown): boolean {
  return error instanceof GrammyError && /not enough rights|CHAT_ADMIN_REQUIRED|rights to pin/i.test(error.description);
}

/** The bot can no longer write to the chat: it left or was removed, or the user blocked it. */
export function isChatGone(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 403 || /chat not found/i.test(error.description));
}

/** The message to edit no longer exists (the user deleted it). */
export function isMessageGone(error: unknown): boolean {
  return error instanceof GrammyError && /message to edit not found|message can't be edited/i.test(error.description);
}

/** Telegram could not parse the message's markup. */
export function isParseError(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400 && /parse|markdown|entit|rich/i.test(error.description);
}

/** The edit changed nothing: a benign outcome of repeated edits. */
export function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

export function describeError(error: unknown): string {
  return error instanceof GrammyError ? `${error.method}: ${error.description}` : error instanceof Error ? error.message : String(error);
}
