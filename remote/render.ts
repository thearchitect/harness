/**
 * A run of the agent as Telegram rich markdown: thinking and every tool call
 * in collapsed <details> blocks, the answer text as is, the finished banner.
 *
 * Pure functions over the run's items; stream.ts decides when a part of the
 * run is shown as a draft and when it is committed as a message.
 */

import type { InputRichMessage } from "grammy/types";

export type Item =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      result?: string;
      isError?: boolean;
      durationMs?: number;
      done: boolean;
    };

/** harness's "per-message-mode-finished" entry (index.ts ModeDetails). */
export type FinishedDetails = {
  mode: "plan" | "normal";
  model?: string;
  effort?: string;
  finishedAt?: number;
  durationMs?: number;
  costUsd?: number;
  interrupted?: boolean;
};

export const FINISHED_ENTRY_TYPE = "per-message-mode-finished";

/** Telegram's limit for one rich message is 32768 characters and 500 blocks; commits stay well below. */
export const MESSAGE_LIMIT = 30_000;
export const COMMIT_CHARS = 12_000;
export const COMMIT_ITEMS = 60;
const RESULT_LIMIT = 3_000;
const SUMMARY_LIMIT = 80;
const DRAFT_TAIL = 3_500;

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A fenced code block whose fence is longer than any backtick run inside. */
export function fence(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${language}\n${text}\n${marks}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more chars` : text;
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** The short description of a tool call shown in its summary line. */
export function toolSummary(name: string, args: unknown): string {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const pick = ["command", "path", "file", "url", "query", "pattern", "code"].find((key) => typeof a[key] === "string");
  const detail = pick !== undefined ? String(a[pick]) : JSON.stringify(args ?? {});
  return oneLine(`${name}: ${detail}`, SUMMARY_LIMIT);
}

/** The text of a tool result ({ content: [{ type: "text", text }, ...] }). */
export function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type ?? "part"}]`))
      .join("\n");
  } else if (typeof result === "string") {
    return result;
  } else {
    return JSON.stringify(result ?? "");
  }
}

function renderItem(item: Item): string {
  switch (item.kind) {
    case "thinking":
      return `<details><summary>💭 Thinking</summary>\n\n${stripAnsi(item.text.trim())}\n\n</details>`;
    case "text":
      return stripAnsi(item.text.trim());
    case "tool": {
      const status = !item.done ? "⏳" : item.isError ? "❌" : "🔧";
      const duration = item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : "";
      const args = JSON.stringify(item.args ?? {}, null, 2);
      const result = item.result !== undefined ? `\n\n${fence(truncate(stripAnsi(item.result), RESULT_LIMIT))}` : "";
      return `<details><summary>${status} ${escapeHtml(toolSummary(item.name, item.args))}${duration}</summary>\n\n${fence(truncate(args, RESULT_LIMIT), "json")}${result}\n\n</details>`;
    }
    default:
      return assertNever(item);
  }
}

export function renderItems(items: readonly Item[]): string {
  return items
    .map(renderItem)
    .filter((part) => part !== "")
    .join("\n\n");
}

/** Splits a long text into parts of at most `limit` characters, at paragraph or line boundaries when possible. */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, "");
  }
  parts.push(rest);
  return parts;
}

/** The live draft: header, the tail of the uncommitted part of the run, the current activity. */
export function renderDraft(header: string, items: readonly Item[], activity: string | undefined): string {
  const body = renderItems(items);
  const tail = body.length > DRAFT_TAIL ? `…\n\n${body.slice(body.length - DRAFT_TAIL).replace(/^[^\n]*\n/, "")}` : body;
  return [`**${header}**`, tail, activity ? `_${activity}_` : ""].filter((part) => part !== "").join("\n\n");
}

/** Rich markdown that Telegram rejected, as one preformatted block of plain text. */
export function plainFallback(markdown: string): InputRichMessage {
  return { blocks: [{ type: "pre", text: markdown.slice(0, MESSAGE_LIMIT) }] };
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  } else {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
}

/** "✅ planning finished · 2m 14s · $0.12 · deepseek-v4-pro" */
export function bannerLine(details: FinishedDetails): string {
  const what = details.mode === "plan" ? "planning" : "building";
  const head = details.interrupted ? `⏹ ${what} interrupted` : `✅ ${what} finished`;
  const model = details.model?.split("/").pop();
  return [
    head,
    details.durationMs !== undefined ? formatDuration(details.durationMs) : undefined,
    details.costUsd !== undefined ? `$${details.costUsd.toFixed(2)}` : undefined,
    model,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function assertNever(value: never): never {
  throw new Error(`unexpected item: ${JSON.stringify(value)}`);
}
