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
  | "sendRichMessageDraft"
  | "pinChatMessage"
  | "unpinChatMessage"
  | "answerCallbackQuery"
  | "getFile"
>;

/** The topic no longer exists (the user deleted it). */
export function isThreadGone(error: unknown): boolean {
  return error instanceof GrammyError && /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(error.description);
}

/** Telegram could not parse the message's markup. */
export function isParseError(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400 && /parse|markdown|entit|rich/i.test(error.description);
}

/** The edit changed nothing: a benign outcome of repeated card updates. */
export function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

export function describeError(error: unknown): string {
  return error instanceof GrammyError ? `${error.method}: ${error.description}` : error instanceof Error ? error.message : String(error);
}
