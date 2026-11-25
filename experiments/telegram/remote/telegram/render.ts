/**
 * The blocks of a run as Telegram rich markdown: a thinking block (live text,
 * collapsed `Thinking` when done), a tool call (collapsed, its summary line
 * says running / duration / failed), the answer text as is; the banner.
 *
 * Pure functions; blocks.ts decides which message shows which block when.
 */

import type { InputRichMessage } from "grammy/types";
import type { FinishedDetails } from "../core/agent.ts";

export type Block =
  | { kind: "thinking"; text: string; done: boolean }
  | { kind: "text"; text: string; done: boolean }
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

/** Telegram's limit for one rich message is 32768 characters and 500 blocks; a page of a block stays well below. */
export const PAGE_LIMIT = 12_000;
const MESSAGE_LIMIT = 30_000;
const RESULT_LIMIT = 3_000;
const SUMMARY_LIMIT = 80;

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A markdown link; `[` and `]` in the text are escaped. */
export function link(text: string, url: string): string {
  return `[${text.replace(/[[\]]/g, "\\$&")}](${url})`;
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

export function oneLine(text: string, limit: number): string {
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

/**
 * The pages of a block: one rich message each. A thinking or text block
 * longer than PAGE_LIMIT continues on further pages; a tool call is one page
 * (its arguments and result are truncated).
 */
export function renderBlock(block: Block): string[] {
  switch (block.kind) {
    case "thinking": {
      const pages = splitText(stripAnsi(block.text.trim()), PAGE_LIMIT);
      return pages.map((page, index) => {
        const title = index === 0 ? "Thinking" : "Thinking (continued)";
        return block.done ? `<details><summary>${title}</summary>\n\n${page}\n\n</details>` : `_${title}…_\n\n${page}`;
      });
    }
    case "text":
      return splitText(stripAnsi(block.text.trim()), PAGE_LIMIT).filter((page) => page !== "");
    case "tool": {
      const duration = block.durationMs !== undefined ? ` · ${formatDuration(block.durationMs)}` : "";
      const status = !block.done ? " · running" : block.isError ? " · failed" : "";
      const args = JSON.stringify(block.args ?? {}, null, 2);
      const result = block.result !== undefined ? `\n\n${fence(truncate(stripAnsi(block.result), RESULT_LIMIT))}` : "";
      return [`<details><summary>${escapeHtml(toolSummary(block.name, block.args))}${duration}${status}</summary>\n\n${fence(truncate(args, RESULT_LIMIT), "json")}${result}\n\n</details>`];
    }
    default:
      return assertNever(block);
  }
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

/** "planning finished · 2m 14s · $0.12 · deepseek-v4-pro" */
export function bannerLine(details: FinishedDetails): string {
  const what = details.mode === "plan" ? "planning" : "building";
  const head = `${what} ${details.interrupted ? "interrupted" : "finished"}`;
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
  throw new Error(`unexpected block: ${JSON.stringify(value)}`);
}
