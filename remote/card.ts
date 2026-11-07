/**
 * The pinned cards: the session card of each topic and the account card of
 * the Account topic. Pure rendering of text (HTML) and buttons from state;
 * lists (models, thinking levels, providers, secrets) open inside the card
 * instead of new messages, so nothing scrolls.
 *
 * callback_data: `c:<action>[:<arg>]` for the session card, `a:<action>[:<arg>]`
 * for the account card (Telegram allows 64 bytes).
 */

import type { Keyboard } from "./outbox.ts";
import { escapeHtml, formatDuration } from "./render.ts";
import type { TurnMode } from "./state.ts";

export type SessionStatus =
  | { kind: "stopped" }
  | { kind: "idle" }
  | { kind: "running"; since: number }
  | { kind: "waiting" }
  | { kind: "compacting" }
  | { kind: "closed" };

export type SessionView =
  | { kind: "main" }
  | { kind: "models"; page: number; models: { provider: string; id: string }[] }
  | { kind: "thinking"; levels: string[] }
  | { kind: "confirmClose" };

export type SessionCard = {
  dir: string;
  model?: string;
  thinking?: string;
  nextMode: TurnMode;
  status: SessionStatus;
  view: SessionView;
};

export const MODELS_PER_PAGE = 8;

export function renderSessionCard(card: SessionCard, now: number): { html: string; keyboard: Keyboard } {
  const model = card.model !== undefined ? ` · 🧠 ${escapeHtml(card.model)}` : "";
  const thinking = card.thinking !== undefined ? ` · 💭 ${escapeHtml(card.thinking)}` : "";
  const next = card.nextMode === "plan" ? "📝 Plan" : "🔨 Build";
  const html = `📁 <b>${escapeHtml(card.dir)}</b>${model}${thinking}\nNext message: ${next} · ${statusText(card.status, now)}`;
  return { html, keyboard: card.status.kind === "closed" ? [] : sessionKeyboard(card) };
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

function sessionKeyboard(card: SessionCard): Keyboard {
  const view = card.view;
  switch (view.kind) {
    case "main": {
      const busy = card.status.kind === "running" || card.status.kind === "waiting" || card.status.kind === "compacting";
      return [
        [
          { text: card.nextMode === "plan" ? "📝 Plan ✓" : "📝 Plan", callback_data: "c:mode:plan" },
          { text: card.nextMode === "build" ? "🔨 Build ✓" : "🔨 Build", callback_data: "c:mode:build" },
        ],
        [
          { text: "🧠 Model", callback_data: "c:models:0" },
          { text: "💭 Thinking", callback_data: "c:thinking" },
          { text: "🗜 Compact", callback_data: "c:compact" },
        ],
        busy ? [{ text: "⏹ Stop", callback_data: "c:stop" }, { text: "✓ Close", callback_data: "c:close" }] : [{ text: "✓ Close", callback_data: "c:close" }],
      ];
    }
    case "models": {
      const pages = Math.max(1, Math.ceil(view.models.length / MODELS_PER_PAGE));
      const start = view.page * MODELS_PER_PAGE;
      const rows: Keyboard = view.models.slice(start, start + MODELS_PER_PAGE).map((m, i) => [
        { text: `${m.provider}/${m.id}`, callback_data: `c:model:${start + i}` },
      ]);
      rows.push([
        ...(view.page > 0 ? [{ text: "‹", callback_data: `c:models:${view.page - 1}` }] : []),
        { text: "✕", callback_data: "c:back" },
        ...(view.page < pages - 1 ? [{ text: "›", callback_data: `c:models:${view.page + 1}` }] : []),
      ]);
      return rows;
    }
    case "thinking":
      return [...view.levels.map((level, i) => [{ text: level, callback_data: `c:level:${i}` }]), [{ text: "✕", callback_data: "c:back" }]];
    case "confirmClose":
      return [[{ text: "✓ Yes, close", callback_data: "c:closeyes" }, { text: "No", callback_data: "c:back" }]];
    default:
      return assertNever(view);
  }
}

export type AccountView =
  | { kind: "main" }
  | { kind: "providers"; providers: { id: string; name: string; loggedIn: boolean }[] }
  | { kind: "secrets"; names: string[] }
  | { kind: "confirmDelete"; name: string };

export type AccountCard = {
  name: string;
  uid: number;
  secrets?: number;
  sessionsRunning: number;
  view: AccountView;
};

export function renderAccountCard(card: AccountCard): { html: string; keyboard: Keyboard } {
  const secrets = card.secrets !== undefined ? `🔐 ${card.secrets} secret${card.secrets === 1 ? "" : "s"} · ` : "";
  const html = `👤 <b>${escapeHtml(card.name)}</b> · uid ${card.uid}\n${secrets}📋 ${card.sessionsRunning} running`;
  return { html, keyboard: accountKeyboard(card.view) };
}

function accountKeyboard(view: AccountView): Keyboard {
  switch (view.kind) {
    case "main":
      return [
        [{ text: "🔑 Login", callback_data: "a:providers" }, { text: "🔐 Secrets", callback_data: "a:secrets" }],
        [{ text: "👤 Key", callback_data: "a:key" }, { text: "📋 Sessions", callback_data: "a:sessions" }],
      ];
    case "providers":
      return [
        ...view.providers.map((p, i) => [
          p.loggedIn
            ? { text: `✓ ${p.name} — log out`, callback_data: `a:logout:${i}` }
            : { text: `🔑 ${p.name}`, callback_data: `a:login:${i}` },
        ]),
        [{ text: "✕", callback_data: "a:back" }],
      ];
    case "secrets":
      return [
        ...view.names.map((name) => [{ text: `🗑 ${name}`, callback_data: `a:del:${name}` }]),
        [{ text: "➕ Add", callback_data: "a:add" }, { text: "✕", callback_data: "a:back" }],
      ];
    case "confirmDelete":
      return [[{ text: `🗑 Delete ${view.name}`, callback_data: `a:delyes:${view.name}` }, { text: "No", callback_data: "a:secrets" }]];
    default:
      return assertNever(view);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
