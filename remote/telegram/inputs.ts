/**
 * Messages to an agent as prompt inputs, with their files.
 *
 * - Every file of the message (documents, photos, videos, audio, voice notes,
 *   animations) and of the message it replies to is saved, as the user, to
 *   ~/tmp/<chat>-<message>/; the prompt starts with the list of their paths.
 *   A file saved before is not downloaded again. Files over Telegram's 20 MB
 *   download limit for bots are listed as not downloaded.
 * - Photos of the message also go to the model as images.
 * - A voice note is transcribed (OpenAI, the user's login): a silent reply
 *   "Transcribing…" grows with the text and ends as "Voice: <transcript>";
 *   the prompt says the text is the transcript of the attached file, so the
 *   model does not process the audio again.
 * - The parts of an album arrive as separate messages: they are collected
 *   until ALBUM_QUIET_MS pass without a new part, then sent as one prompt.
 *
 * Preparation (downloads, transcription) runs outside the user's queue, in a
 * chain per chat: prompts keep the order of their messages, and /stop is never
 * held up by a download.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "grammy/types";
import { homeOf } from "../accounts.ts";
import type { UserConfig } from "../config.ts";
import type { UserInput } from "../core/agent.ts";
import type { Clock, Timer } from "../core/clock.ts";
import { DOWNLOAD_LIMIT, formatSize, readFileAs, saveIncomingAs } from "../files.ts";
import type { Telemetry } from "../telemetry.ts";
import type { Workbench } from "../workbench.ts";
import { escapeHtml } from "./render.ts";

export const ALBUM_QUIET_MS = 1_500;
const TRANSCRIPT_EDIT_MS = 3_000;
const QUOTE_LIMIT = 500;

export type InputsDeps = {
  workbench: Workbench;
  clock: Clock;
  t: Telemetry;
  download(fileId: string): Promise<Buffer>;
};

type Attachment = {
  fileId: string;
  name: string;
  size: number;
  kind: "file" | "photo" | "voice";
  durationS?: number;
  messageId: number;
  fromReply: boolean;
};

type Listed = { line: string; path?: string; attachment: Attachment };

/** The files of a message, with the names they get on disk. */
export function attachmentsOf(message: Message, fromReply: boolean): Attachment[] {
  const at = { messageId: message.message_id, fromReply };
  const found: Attachment[] = [];
  const largest = message.photo?.at(-1);
  if (largest !== undefined) found.push({ ...at, kind: "photo", fileId: largest.file_id, name: `photo-${message.message_id}.jpg`, size: largest.file_size ?? 0 });
  if (message.voice !== undefined) {
    found.push({ ...at, kind: "voice", fileId: message.voice.file_id, name: "voice.oga", size: message.voice.file_size ?? 0, durationS: message.voice.duration });
  }
  for (const [file, fallback] of [
    [message.document, "file"],
    [message.video, "video.mp4"],
    [message.audio, "audio"],
    [message.animation, "animation.mp4"],
    [message.video_note, "video-note.mp4"],
  ] as const) {
    if (file !== undefined) {
      const name = "file_name" in file && typeof file.file_name === "string" ? file.file_name : fallback;
      found.push({ ...at, kind: "file", fileId: file.file_id, name, size: file.file_size ?? 0 });
    }
  }
  return found;
}

/** The message carries something for an agent (text or files). */
export function hasInput(message: Message): boolean {
  return (message.text ?? message.caption) !== undefined || attachmentsOf(message, false).length > 0;
}

export class Inputs {
  private readonly deps: InputsDeps;
  private readonly chains = new Map<number, Promise<unknown>>();
  private readonly albums = new Map<string, { messages: Message[]; timer: Timer; done: Promise<void>; resolve(): void }>();

  constructor(deps: InputsDeps) {
    this.deps = deps;
  }

  private get wb(): Workbench {
    return this.deps.workbench;
  }

  /** A message for the workspace's agent; resolves when its prompt has been submitted. */
  add(user: UserConfig, message: Message): Promise<void> {
    const group = message.media_group_id;
    if (group === undefined) {
      return this.enqueue(user, message.chat.id, [message]);
    } else {
      const key = `${message.chat.id}:${group}`;
      const album = this.albums.get(key);
      if (album !== undefined) {
        album.messages.push(message);
        album.timer.cancel();
        album.timer = this.deps.clock.after(ALBUM_QUIET_MS, () => this.flushAlbum(user, key));
        return album.done;
      } else {
        let resolve!: () => void;
        const done = new Promise<void>((r) => (resolve = r));
        this.albums.set(key, { messages: [message], timer: this.deps.clock.after(ALBUM_QUIET_MS, () => this.flushAlbum(user, key)), done, resolve });
        return done;
      }
    }
  }

  private flushAlbum(user: UserConfig, key: string): void {
    const album = this.albums.get(key);
    if (album !== undefined) {
      this.albums.delete(key);
      const first = album.messages[0] as Message;
      void this.enqueue(user, first.chat.id, album.messages.sort((a, b) => a.message_id - b.message_id)).then(album.resolve);
    } else {
      // flushed already
    }
  }

  private enqueue(user: UserConfig, chatId: number, messages: Message[]): Promise<void> {
    const previous = this.chains.get(chatId) ?? Promise.resolve();
    const step = async (): Promise<void> => {
      const input = await this.prepare(user, chatId, messages);
      if (input !== undefined) await this.wb.serial(user.telegramId, () => this.wb.prompt(user, chatId, input));
    };
    const next = previous.then(step, step).catch((error: unknown) => {
      this.deps.t.error("input.failed", { user: user.name, chat: chatId, message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    });
    this.chains.set(chatId, next);
    return next;
  }

  /** Files saved, voice transcribed, the prompt text composed; undefined when nothing is left to send. */
  private async prepare(user: UserConfig, chatId: number, messages: Message[]): Promise<UserInput | undefined> {
    const outbox = this.wb.outbox(chatId);
    const reply = messages[0]?.reply_to_message;
    const attachments = [...messages.flatMap((m) => attachmentsOf(m, false)), ...(reply !== undefined ? attachmentsOf(reply, true) : [])];
    const listed: Listed[] = [];
    for (const attachment of attachments) listed.push(await this.save(user, chatId, attachment));
    const images: { data: string; mimeType: string }[] = [];
    for (const item of listed) {
      if (item.attachment.kind === "photo" && !item.attachment.fromReply && item.path !== undefined) {
        const data = await readFileAs(this.wb.config, user, item.path);
        if (data.ok) images.push({ data: data.data.toString("base64"), mimeType: "image/jpeg" });
      }
    }
    const voice = listed.find((item) => item.attachment.kind === "voice" && !item.attachment.fromReply);
    let transcript: string | undefined;
    if (voice !== undefined) {
      if (voice.path === undefined) {
        await outbox.send({ html: "Error: the voice message could not be saved." }, { silent: false });
        return undefined;
      }
      transcript = await this.transcribe(user, chatId, voice.attachment.messageId, voice.path);
      if (transcript === undefined) return undefined;
    } else {
      // no voice note
    }
    const texts = messages.map((m) => m.text ?? m.caption ?? "").filter((t) => t.trim() !== "");
    const parts: string[] = [];
    if (listed.length > 0) parts.push(["Attached files:", ...listed.map((item) => `- ${item.line}`)].join("\n"));
    if (transcript !== undefined && voice !== undefined) {
      parts.push(`This message was spoken: its text below is the transcript of the attached ${voice.attachment.name}. Work with the text; the audio needs no processing.`);
      parts.push(transcript);
    } else {
      // a typed message
    }
    parts.push(...texts);
    if (reply !== undefined && reply.from?.is_bot === true) {
      const quoted = (reply.text ?? reply.caption ?? "").slice(0, QUOTE_LIMIT);
      if (quoted !== "") parts.push(`[in reply to: ${quoted}]`);
    } else {
      // not a reply to the bot
    }
    const text = parts.join("\n\n");
    return text === "" && images.length === 0 ? undefined : { text, images: images.length > 0 ? images : undefined };
  }

  private async save(user: UserConfig, chatId: number, attachment: Attachment): Promise<Listed> {
    const folder = `${chatId}-${attachment.messageId}`;
    const path = join(homeOf(this.wb.config, user), "tmp", folder, attachment.name);
    const what = [
      formatSize(attachment.size),
      ...(attachment.kind === "voice" ? [`voice message, ${formatClock(attachment.durationS ?? 0)}`] : []),
      ...(attachment.fromReply ? ["from the message you replied to"] : []),
    ].join(", ");
    if (attachment.size > DOWNLOAD_LIMIT) {
      return { attachment, line: `${attachment.name} (${formatSize(attachment.size)}, not downloaded: over Telegram's 20 MB limit for bots)` };
    } else if (existsSync(path)) {
      return { attachment, path, line: `${path} (${what})` };
    } else {
      try {
        const data = await this.deps.download(attachment.fileId);
        const saved = await saveIncomingAs(this.wb.config, user, folder, attachment.name, data);
        this.deps.t.info("file.receive", { user: user.name, chat: chatId, kind: attachment.kind, size: data.length, ok: saved.ok, ...(saved.ok ? {} : { message: saved.problem }) });
        return saved.ok ? { attachment, path: saved.data, line: `${saved.data} (${what})` } : { attachment, line: `${attachment.name} (not saved: ${saved.problem})` };
      } catch (error) {
        this.deps.t.warn("file.receive", { user: user.name, chat: chatId, kind: attachment.kind, message: String(error) });
        return { attachment, line: `${attachment.name} (not downloaded: ${String(error)})` };
      }
    }
  }

  /** Transcribes a voice note with progress in one reply; resolves with the text, or undefined (reported). */
  private async transcribe(user: UserConfig, chatId: number, messageId: number, path: string): Promise<string | undefined> {
    const outbox = this.wb.outbox(chatId);
    const progressId = await outbox.send({ html: "Transcribing…" }, { replyTo: messageId });
    let text = "";
    let shown = "";
    let timer: Timer | undefined;
    const show = (): void => {
      timer = undefined;
      if (progressId !== undefined && text !== shown) {
        shown = text;
        void outbox.edit(progressId, { html: `Transcribing…\n${escapeHtml(text)}` });
      } else {
        // nothing new to show
      }
    };
    const startedAt = this.deps.clock.now();
    const result = await this.wb.keepAwake(() =>
      this.wb.transcribe(user, path, (delta) => {
        text += delta;
        timer ??= this.deps.clock.after(TRANSCRIPT_EDIT_MS, show);
      }),
    );
    timer?.cancel();
    this.deps.t.info("voice.transcribe", { user: user.name, chat: chatId, ms: this.deps.clock.now() - startedAt, ok: result.ok, ...(result.ok ? {} : { message: result.problem }) });
    if (result.ok && result.data !== "") {
      const final = `Voice: ${escapeHtml(result.data)}`;
      if (progressId !== undefined) {
        await outbox.edit(progressId, { html: final });
      } else {
        await outbox.send({ html: final });
      }
      return result.data;
    } else {
      const problem = result.ok ? "nothing was recognised" : /no OpenAI login/.test(result.problem) ? "Voice needs an OpenAI login: /login → OpenAI Codex." : result.problem;
      if (progressId !== undefined) await outbox.edit(progressId, { html: "Transcription failed." });
      await outbox.send({ html: `Error: ${escapeHtml(problem)}` }, { silent: false });
      return undefined;
    }
  }
}

/** 0:42, 12:05 */
function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}
