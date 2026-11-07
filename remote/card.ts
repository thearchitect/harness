/**
 * What the user sees of the controls:
 *
 * - the chat's persistent reply keyboard: four section buttons, the same in
 *   every topic (Telegram shows one reply keyboard for the whole chat); a
 *   press acts on the topic it was sent from;
 * - the pinned status card of a session topic: text only (the pinned bar
 *   shows its first line), no buttons — nobody has to scroll up to it;
 * - panels: the inline second level of a section, posted as the last message
 *   of the topic and edited in place while the user navigates; the outcome
 *   replaces the panel's text.
 *
 * callback_data of panel buttons: `s:<action>[:<arg>]` (session),
 * `a:<action>[:<arg>]` (account); Telegram allows 64 bytes.
 */

import type { ReplyKeyboardMarkup } from "grammy/types";
import type { Keyboard } from "./outbox.ts";
import { escapeHtml, formatDuration } from "./render.ts";
import type { TurnMode } from "./state.ts";

/** The section buttons; a press arrives as a message with exactly this text. */
export const SECTIONS = {
  build: "🔨 Build",
  stop: "⏹ Stop",
  model: "🧠 Model",
  more: "⚙️ More",
} as const;
export type Section = keyof typeof SECTIONS;

/** Bump when the keyboard changes: every user gets it again. */
export const KEYBOARD_VERSION = 1;

export const REPLY_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: SECTIONS.build }, { text: SECTIONS.stop }, { text: SECTIONS.model }, { text: SECTIONS.more }]],
  is_persistent: true,
  resize_keyboard: true,
  input_field_placeholder: "Task, or a reply to the agent…",
};

export function sectionOf(text: string | undefined): Section | undefined {
  const entry = Object.entries(SECTIONS).find(([, label]) => label === text);
  return entry !== undefined ? (entry[0] as Section) : undefined;
}

export type SessionStatus =
  | { kind: "stopped" }
  | { kind: "idle" }
  | { kind: "running"; since: number }
  | { kind: "waiting" }
  | { kind: "compacting" }
  | { kind: "closed" };

export type SessionCard = {
  dir: string;
  model?: string;
  thinking?: string;
  nextMode: TurnMode;
  status: SessionStatus;
};

/** The pinned status: "📁 ~/proj · 🧠 deepseek-v4-pro · 💭 max · 📝 Plan · ● idle". */
export function renderSessionCard(card: SessionCard, now: number): string {
  const parts = [
    `📁 <b>${escapeHtml(card.dir)}</b>`,
    ...(card.model !== undefined ? [`🧠 ${escapeHtml(card.model.split("/").pop() ?? card.model)}`] : []),
    ...(card.thinking !== undefined ? [`💭 ${escapeHtml(card.thinking)}`] : []),
    card.nextMode === "plan" ? "📝 Plan" : "🔨 Build next",
    statusText(card.status, now),
  ];
  return parts.join(" · ");
}

function statusText(status: SessionStatus, now: number): string {
  switch (status.kind) {
    case "stopped":
      return "○ stopped";
    case "idle":
      return "● idle";
    case "running":
      return `⏳ running ${formatDuration(now - status.since)}`;
    case "waiting":
      return "⏸ waiting for you";
    case "compacting":
      return "🗜 compacting…";
    case "closed":
      return "✓ closed";
    default:
      return assertNever(status);
  }
}

export const MODELS_PER_PAGE = 8;

/** ⚙️ More: session actions (in a session topic) and the account. */
export function morePanel(inSession: boolean): { html: string; keyboard: Keyboard } {
  return {
    html: "⚙️ <b>More</b>",
    keyboard: [
      ...(inSession
        ? [[
            { text: "💭 Thinking", callback_data: "s:thinking" },
            { text: "🗜 Compact", callback_data: "s:compact" },
            { text: "✓ Close", callback_data: "s:close" },
          ]]
        : []),
      [
        { text: "🔑 Login", callback_data: "a:providers" },
        { text: "🔐 Secrets", callback_data: "a:secrets" },
      ],
      [
        { text: "👤 Key", callback_data: "a:key" },
        { text: "📋 Sessions", callback_data: "a:sessions" },
        { text: "❓ Help", callback_data: "a:help" },
      ],
      [{ text: "✕", callback_data: "s:dismiss" }],
    ],
  };
}

export function modelsPanel(models: { provider: string; id: string }[], page: number, current: string | undefined): { html: string; keyboard: Keyboard } {
  const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
  const start = page * MODELS_PER_PAGE;
  const rows: Keyboard = models.slice(start, start + MODELS_PER_PAGE).map((m, i) => {
    const name = `${m.provider}/${m.id}`;
    return [{ text: name === current ? `✓ ${name}` : name, callback_data: `s:model:${start + i}` }];
  });
  rows.push([
    ...(page > 0 ? [{ text: "‹", callback_data: `s:models:${page - 1}` }] : []),
    { text: "✕", callback_data: "s:dismiss" },
    ...(page < pages - 1 ? [{ text: "›", callback_data: `s:models:${page + 1}` }] : []),
  ]);
  return { html: models.length > 0 ? `🧠 <b>Model</b>${pages > 1 ? ` (${page + 1}/${pages})` : ""}` : "🧠 No models available — log in or add an API key (⚙️ More).", keyboard: rows };
}

export function thinkingPanel(levels: string[], current: string | undefined): { html: string; keyboard: Keyboard } {
  return {
    html: "💭 <b>Thinking level</b>",
    keyboard: [
      levels.map((level, i) => ({ text: level === current ? `✓ ${level}` : level, callback_data: `s:level:${i}` })),
      [{ text: "✕", callback_data: "s:dismiss" }],
    ],
  };
}

export function closePanel(): { html: string; keyboard: Keyboard } {
  return {
    html: "✓ <b>Close this session?</b> The topic stays as history.",
    keyboard: [[{ text: "✓ Close", callback_data: "s:closeyes" }, { text: "✕", callback_data: "s:dismiss" }]],
  };
}

export function buildPanel(nextMode: TurnMode): { html: string; keyboard: Keyboard } {
  return nextMode === "build"
    ? { html: "🔨 <b>The next message builds.</b>", keyboard: [[{ text: "📝 Back to Plan", callback_data: "s:mode:plan" }]] }
    : { html: "📝 The next message plans.", keyboard: [[{ text: "🔨 Build next", callback_data: "s:mode:build" }]] };
}

export function providersPanel(providers: { id: string; name: string; loggedIn: boolean }[]): { html: string; keyboard: Keyboard } {
  return {
    html: "🔑 <b>Log in</b> — OAuth providers. On a phone, prefer the ones with a device code (e.g. OpenAI Codex).",
    keyboard: [
      ...providers.map((p, i) => [
        p.loggedIn ? { text: `✓ ${p.name} — log out`, callback_data: `a:logout:${i}` } : { text: `🔑 ${p.name}`, callback_data: `a:login:${i}` },
      ]),
      [{ text: "✕", callback_data: "a:dismiss" }],
    ],
  };
}

export function secretsPanel(names: string[]): { html: string; keyboard: Keyboard } {
  return {
    html: names.length > 0 ? `🔐 <b>Your secrets</b> (tap to delete):` : "🔐 <b>No secrets yet.</b> They reach every new session as environment variables.",
    keyboard: [
      ...names.map((name) => [{ text: `🗑 ${name}`, callback_data: `a:del:${name}` }]),
      [{ text: "➕ Add", callback_data: "a:add" }, { text: "✕", callback_data: "a:dismiss" }],
    ],
  };
}

export function deleteSecretPanel(name: string): { html: string; keyboard: Keyboard } {
  return {
    html: `🗑 Delete <code>${escapeHtml(name)}</code>?`,
    keyboard: [[{ text: "🗑 Delete", callback_data: `a:delyes:${name}` }, { text: "✕", callback_data: "a:secrets" }]],
  };
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
