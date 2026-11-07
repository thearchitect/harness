/**
 * One run of the agent in a topic, as the user sees it while it happens:
 *
 * - a live draft (header with mode and elapsed time, thinking, answer, the
 *   current action) with Telegram's native stop button, refreshed at most
 *   once a second on new content and at least every 20 s (a draft lives 30 s);
 * - silent committed messages when the uncommitted part grows large (checked
 *   at turn boundaries) and before a dialog;
 * - the final message with the banner, with sound.
 *
 * While a dialog waits for the user the view is paused: no draft.
 */

import type { Clock, Timer } from "./clock.ts";
import type { Outbox } from "./outbox.ts";
import {
  COMMIT_CHARS,
  COMMIT_ITEMS,
  formatDuration,
  type Item,
  MESSAGE_LIMIT,
  renderDraft,
  renderItems,
  resultText,
  splitText,
  toolSummary,
} from "./render.ts";
import type { RpcEvent } from "./rpc.ts";

const DRAFT_MIN_INTERVAL_MS = 1_000;
const DRAFT_KEEPALIVE_MS = 20_000;

export class RunView {
  readonly draftId: number;
  private readonly outbox: Outbox;
  private readonly clock: Clock;
  private readonly title: string;
  private readonly startedAt: number;
  private items: Item[] = [];
  private blocks = new Map<number, Item>(); // contentIndex → item of the current assistant message
  private activity: string | undefined;
  private paused = false;
  private finished = false;
  private lastDraftAt = Number.NEGATIVE_INFINITY;
  private draftTimer: Timer | undefined;
  private keepaliveTimer: Timer | undefined;

  /** `title`: "Planning" or "Building"; `draftId`: unique per run, non-zero. */
  constructor(outbox: Outbox, clock: Clock, title: string, draftId: number) {
    this.outbox = outbox;
    this.clock = clock;
    this.title = title;
    this.draftId = draftId;
    this.startedAt = clock.now();
    this.changed();
  }

  onEvent(event: RpcEvent): void {
    if (this.finished) return;
    switch (event.type) {
      case "message_start":
        this.blocks = new Map();
        break;
      case "message_end": {
        const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (message.role === "assistant" && message.stopReason === "error") {
          this.items.push({ kind: "text", text: `Error: ${message.errorMessage ?? "the model request failed"}` });
          this.changed();
        } else {
          // a normal message: its blocks are already shown
        }
        break;
      }
      case "message_update":
        this.onAssistantDelta(event.assistantMessageEvent);
        break;
      case "tool_execution_start":
        this.items.push({ kind: "tool", id: event.toolCallId, name: event.toolName, args: event.args, done: false });
        this.activity = toolSummary(event.toolName, event.args);
        this.changed();
        break;
      case "tool_execution_end": {
        const tool = this.items.find((item) => item.kind === "tool" && item.id === event.toolCallId);
        if (tool !== undefined && tool.kind === "tool") {
          tool.done = true;
          tool.result = resultText(event.result);
          tool.isError = event.isError;
          tool.durationMs = event.durationMs;
        } else {
          // the call was committed already, or started before this view
        }
        this.activity = undefined;
        this.changed();
        break;
      }
      case "auto_retry_start":
        this.activity = `retrying ${event.attempt}/${event.maxAttempts} in ${formatDuration(event.delayMs)}: ${event.errorMessage}`;
        this.changed();
        break;
      case "auto_retry_end":
      case "compaction_end":
        this.activity = undefined;
        this.changed();
        break;
      case "compaction_start":
        this.activity = "compacting…";
        this.changed();
        break;
      case "turn_end":
        if (renderItems(this.items).length >= COMMIT_CHARS || this.items.length >= COMMIT_ITEMS) {
          void this.commit();
        } else {
          // small enough to stay in the draft
        }
        break;
      default:
        // other events change nothing on screen
        break;
    }
  }

  /** A dialog opens: what happened so far is committed above it; no draft. */
  async pause(): Promise<void> {
    this.paused = true;
    this.stopTimers();
    await this.commit();
  }

  resume(): void {
    if (this.finished || !this.paused) return;
    this.paused = false;
    this.changed();
  }

  /** The run settled: the rest and the banner; the last message with sound. */
  async finish(banner: string | undefined): Promise<number | undefined> {
    this.finished = true;
    this.stopTimers();
    const chunks = this.chunks([...this.items.map((i) => renderItems([i])), ...(banner !== undefined ? [banner] : [])]);
    this.items = [];
    let last: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const final = index === chunks.length - 1;
      last = await this.outbox.send({ markdown: chunk }, { silent: !final });
    }
    return last;
  }

  /** Stops timers without sending anything (the topic is gone, the process died). */
  dispose(): void {
    this.finished = true;
    this.stopTimers();
  }

  private onAssistantDelta(update: { type: string; contentIndex?: number; delta?: string; content?: string }): void {
    const index = update.contentIndex ?? -1;
    switch (update.type) {
      case "thinking_start":
      case "text_start": {
        const item: Item = { kind: update.type === "thinking_start" ? "thinking" : "text", text: "" };
        this.blocks.set(index, item);
        this.items.push(item);
        break;
      }
      case "thinking_delta":
      case "text_delta": {
        const item = this.blocks.get(index);
        if (item !== undefined && item.kind !== "tool") item.text += update.delta ?? "";
        break;
      }
      case "thinking_end":
      case "text_end": {
        const item = this.blocks.get(index);
        if (item !== undefined && item.kind !== "tool" && update.content !== undefined) item.text = update.content;
        break;
      }
      default:
        return; // tool-call deltas: the tool_execution events carry the call
    }
    this.changed();
  }

  private async commit(): Promise<void> {
    const ready = this.items;
    this.items = [];
    for (const chunk of this.chunks(ready.map((i) => renderItems([i])))) {
      await this.outbox.send({ markdown: chunk });
    }
  }

  /** Rendered parts packed into messages below the size limit; oversized parts are split. */
  private chunks(parts: string[]): string[] {
    const chunks: string[] = [];
    let current = "";
    for (const part of parts.filter((p) => p !== "").flatMap((p) => splitText(p, MESSAGE_LIMIT))) {
      if (current !== "" && current.length + part.length + 2 > MESSAGE_LIMIT) {
        chunks.push(current);
        current = part;
      } else {
        current = current === "" ? part : `${current}\n\n${part}`;
      }
    }
    if (current !== "") chunks.push(current);
    return chunks;
  }

  private changed(): void {
    if (this.paused || this.finished) {
      return;
    } else if (this.draftTimer !== undefined) {
      // a draft is already scheduled; it will carry this change
    } else {
      const wait = Math.max(0, this.lastDraftAt + DRAFT_MIN_INTERVAL_MS - this.clock.now());
      this.draftTimer = this.clock.after(wait, () => this.sendDraft());
    }
  }

  private sendDraft(): void {
    this.draftTimer = undefined;
    if (this.paused || this.finished) return;
    this.lastDraftAt = this.clock.now();
    const header = `${this.title} · ${formatDuration(this.clock.now() - this.startedAt)}`;
    void this.outbox.draft(this.draftId, renderDraft(header, this.items, this.activity));
    this.keepaliveTimer?.cancel();
    this.keepaliveTimer = this.clock.after(DRAFT_KEEPALIVE_MS, () => {
      this.keepaliveTimer = undefined;
      this.changed();
    });
  }

  private stopTimers(): void {
    this.draftTimer?.cancel();
    this.draftTimer = undefined;
    this.keepaliveTimer?.cancel();
    this.keepaliveTimer = undefined;
  }
}
