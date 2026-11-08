/**
 * One run of an agent as messages in a chat: every block is a message of its
 * own, edited in place while it grows, and stays when the run is over.
 *
 * - A thinking block: live text, collapsed `Thinking` when done.
 * - A tool call: a collapsed block whose summary says running, then the
 *   duration (or failed) with the result inside.
 * - The answer text.
 * - A block longer than a page continues in the next message.
 *
 * All sends and edits of the run go out in flushes at most every
 * FLUSH_INTERVAL_MS (Telegram allows about 20 messages a minute in a group),
 * each with the latest state of every changed block. The inline Stop button
 * sits on the last message of the run while it is live. A message the user
 * deleted is sent again.
 */

import type { Clock, Timer } from "../core/clock.ts";
import type { RpcEvent } from "../core/rpc.ts";
import type { Keyboard, Outbox } from "./outbox.ts";
import { type Block, formatDuration, renderBlock, resultText } from "./render.ts";

export const FLUSH_INTERVAL_MS = 3_000;

type Page = { messageId?: number; text: string };
type Shown = { block: Block; pages: Page[]; dirty: boolean };

export class BlockStream {
  private readonly outbox: Outbox;
  private readonly clock: Clock;
  private readonly stopKeyboard: Keyboard;
  private readonly shown: Shown[] = [];
  /** contentIndex → block of the assistant message being streamed. */
  private streaming = new Map<number, Shown>();
  private live = true;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private timer: Timer | undefined;
  private flushing: Promise<void> = Promise.resolve();
  /** The message carrying the Stop button. */
  private stopOn: number | undefined;

  /** `stopData`: callback_data of the Stop button. */
  constructor(outbox: Outbox, clock: Clock, stopData: string) {
    this.outbox = outbox;
    this.clock = clock;
    this.stopKeyboard = [[{ text: "Stop", callback_data: stopData }]];
  }

  onEvent(event: RpcEvent): void {
    if (!this.live) return;
    switch (event.type) {
      case "message_start":
        this.streaming = new Map();
        return;
      case "message_update":
        this.onDelta(event.assistantMessageEvent as { type: string; contentIndex?: number; delta?: string; content?: string });
        return;
      case "message_end": {
        const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (message.role === "assistant" && message.stopReason === "error") {
          this.add({ kind: "text", text: `Error: ${message.errorMessage ?? "the model request failed"}`, done: true });
        } else {
          // the message's blocks are shown already
        }
        return;
      }
      case "tool_execution_start":
        this.add({ kind: "tool", id: event.toolCallId, name: event.toolName, args: event.args, done: false });
        return;
      case "tool_execution_end": {
        const shown = this.shown.find((s) => s.block.kind === "tool" && s.block.id === event.toolCallId);
        if (shown !== undefined && shown.block.kind === "tool") {
          shown.block.done = true;
          shown.block.result = resultText(event.result);
          shown.block.isError = event.isError;
          shown.block.durationMs = event.durationMs;
          this.changed(shown);
        } else {
          // a call that started before this stream (the agent moved here mid-call)
        }
        return;
      }
      case "auto_retry_start":
        this.add({ kind: "text", text: `_retrying ${event.attempt}/${event.maxAttempts} in ${formatDuration(event.delayMs)}: ${event.errorMessage}_`, done: true });
        return;
      default:
        return; // other events change nothing on screen
    }
  }

  /** The run settled: every block in its final state, no Stop; then the banner, with sound. */
  async finish(banner: string): Promise<void> {
    await this.end();
    await this.outbox.send({ markdown: banner }, { silent: false });
  }

  /** The run continues elsewhere, or the process is gone: final states, no Stop; an optional silent note. */
  async close(note?: string): Promise<void> {
    await this.end();
    if (note !== undefined) await this.outbox.send({ markdown: note });
  }

  /* ------------------------------------------------------------------------ */

  private onDelta(update: { type: string; contentIndex?: number; delta?: string; content?: string }): void {
    const index = update.contentIndex ?? -1;
    switch (update.type) {
      case "thinking_start":
      case "text_start":
        this.streaming.set(index, this.add({ kind: update.type === "thinking_start" ? "thinking" : "text", text: "", done: false }));
        return;
      case "thinking_delta":
      case "text_delta": {
        const shown = this.streaming.get(index);
        if (shown !== undefined && shown.block.kind !== "tool") {
          shown.block.text += update.delta ?? "";
          this.changed(shown);
        }
        return;
      }
      case "thinking_end":
      case "text_end": {
        const shown = this.streaming.get(index);
        if (shown !== undefined && shown.block.kind !== "tool") {
          if (update.content !== undefined) shown.block.text = update.content;
          shown.block.done = true;
          this.changed(shown);
        }
        return;
      }
      default:
        return; // tool-call deltas: the tool_execution events carry the call
    }
  }

  private add(block: Block): Shown {
    const shown: Shown = { block, pages: [], dirty: true };
    this.shown.push(shown);
    this.schedule();
    return shown;
  }

  private changed(shown: Shown): void {
    shown.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || !this.live) {
      return; // a flush is scheduled already, or the stream ended
    } else {
      const wait = Math.max(0, this.lastFlushAt + FLUSH_INTERVAL_MS - this.clock.now());
      this.timer = this.clock.after(wait, () => {
        this.timer = undefined;
        void this.flush();
      });
    }
  }

  private async end(): Promise<void> {
    this.live = false;
    this.timer?.cancel();
    this.timer = undefined;
    await this.flush();
  }

  /** Sends and edits what changed; flushes never overlap. */
  private flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    this.lastFlushAt = this.clock.now();
    for (const shown of this.shown) {
      if (shown.dirty) {
        shown.dirty = false;
        const texts = renderBlock(shown.block);
        for (const [index, text] of texts.entries()) {
          const page = shown.pages[index] ?? { text: "" };
          shown.pages[index] = page;
          if (text === "") {
            // nothing to show yet (a block that has just started)
          } else if (page.messageId === undefined) {
            page.text = text;
            page.messageId = await this.outbox.send({ markdown: text });
          } else if (page.text !== text) {
            page.text = text;
            if ((await this.outbox.edit(page.messageId, { markdown: text }, page.messageId === this.stopOn && this.live ? this.stopKeyboard : undefined)) === "gone") {
              page.messageId = await this.outbox.send({ markdown: text });
            }
          } else {
            // unchanged page
          }
        }
      } else {
        // unchanged block
      }
    }
    await this.moveStop();
  }

  /** The Stop button on the last message of the live run, nowhere else. */
  private async moveStop(): Promise<void> {
    const last = this.lastPage();
    const target = this.live ? last?.messageId : undefined;
    if (target === this.stopOn) {
      return; // already in place
    }
    const previous = this.pageOf(this.stopOn);
    if (previous?.messageId !== undefined) await this.outbox.edit(previous.messageId, { markdown: previous.text });
    if (target !== undefined && last !== undefined) await this.outbox.edit(target, { markdown: last.text }, this.stopKeyboard);
    this.stopOn = target;
  }

  private lastPage(): Page | undefined {
    for (let i = this.shown.length - 1; i >= 0; i--) {
      const pages = (this.shown[i] as Shown).pages.filter((p) => p.messageId !== undefined);
      if (pages.length > 0) return pages[pages.length - 1];
    }
    return undefined;
  }

  private pageOf(messageId: number | undefined): Page | undefined {
    return messageId === undefined ? undefined : this.shown.flatMap((s) => s.pages).find((p) => p.messageId === messageId);
  }
}
