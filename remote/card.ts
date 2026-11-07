/**
 * Plain texts and inline panels of the controls:
 *
 * - the pinned status line of a place with an agent (the counterpart of the
 *   TUI footer): directory · model · thinking · state;
 * - panels: the choices of a command (/agent, /model, /thinking, /close,
 *   /login, /secrets), posted as the last message of the place and edited in
 *   place while the user navigates; the outcome replaces the panel's text.
 *
 * callback_data: `s:<action>[:<arg>]` (agent), `a:<action>[:<arg>]` (account),
 * `p:<index>` (directory of /agent); Telegram allows 64 bytes.
 */

import type { Keyboard } from "./outbox.ts";
import { escapeHtml, formatDuration } from "./render.ts";

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
  status: SessionStatus;
};

/** "~/proj · deepseek-v4-pro · max · idle" */
export function renderSessionCard(card: SessionCard, now: number): string {
  return [
    escapeHtml(card.dir),
    ...(card.model !== undefined ? [escapeHtml(card.model.split("/").pop() ?? card.model)] : []),
    ...(card.thinking !== undefined ? [escapeHtml(card.thinking)] : []),
    statusText(card.status, now),
  ].join(" · ");
}

function statusText(status: SessionStatus, now: number): string {
  switch (status.kind) {
    case "stopped":
      return "stopped";
    case "idle":
      return "idle";
    case "running":
      return `running ${formatDuration(now - status.since)}`;
    case "waiting":
      return "waiting for you";
    case "compacting":
      return "compacting";
    case "closed":
      return "closed";
    default:
      return assertNever(status);
  }
}

export const MODELS_PER_PAGE = 8;
const CANCEL = { text: "Cancel", callback_data: "s:dismiss" };

export function dirsPanel(dirs: string[]): { html: string; keyboard: Keyboard } {
  const buttons = dirs.map((dir, index) => ({ text: dir, callback_data: `p:${index}` }));
  const rows: Keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([CANCEL]);
  return { html: "Directory for the agent (or <code>/agent path</code>):", keyboard: rows };
}

export function modelsPanel(models: { provider: string; id: string }[], page: number, current: string | undefined): { html: string; keyboard: Keyboard } {
  const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
  const start = page * MODELS_PER_PAGE;
  const rows: Keyboard = models.slice(start, start + MODELS_PER_PAGE).map((m, i) => {
    const name = `${m.provider}/${m.id}`;
    return [{ text: name === current ? `${name} (current)` : name, callback_data: `s:model:${start + i}` }];
  });
  rows.push([
    ...(page > 0 ? [{ text: "Previous", callback_data: `s:models:${page - 1}` }] : []),
    CANCEL,
    ...(page < pages - 1 ? [{ text: "Next", callback_data: `s:models:${page + 1}` }] : []),
  ]);
  return { html: models.length > 0 ? `Model${pages > 1 ? ` (${page + 1}/${pages})` : ""}:` : "No models available: /login or add an API key with /secrets.", keyboard: rows };
}

export function thinkingPanel(levels: string[], current: string | undefined): { html: string; keyboard: Keyboard } {
  return {
    html: "Thinking level:",
    keyboard: [levels.map((level, i) => ({ text: level === current ? `${level} (current)` : level, callback_data: `s:level:${i}` })), [CANCEL]],
  };
}

export function closePanel(dir: string): { html: string; keyboard: Keyboard } {
  return {
    html: `Close the agent in ${escapeHtml(dir)}? Its session stays on disk.`,
    keyboard: [[{ text: "Close", callback_data: "s:closeyes" }, CANCEL]],
  };
}

export function providersPanel(providers: { id: string; name: string; loggedIn: boolean }[]): { html: string; keyboard: Keyboard } {
  return {
    html: "Log in to a provider:",
    keyboard: [
      ...providers.map((p, i) => [
        p.loggedIn ? { text: `${p.name}: log out`, callback_data: `a:logout:${i}` } : { text: p.name, callback_data: `a:login:${i}` },
      ]),
      [{ text: "Cancel", callback_data: "a:dismiss" }],
    ],
  };
}

export function secretsPanel(names: string[]): { html: string; keyboard: Keyboard } {
  return {
    html: names.length > 0 ? "Secrets (tap to delete):" : "No secrets.",
    keyboard: [
      ...names.map((name) => [{ text: name, callback_data: `a:del:${name}` }]),
      [{ text: "Add", callback_data: "a:add" }, { text: "Cancel", callback_data: "a:dismiss" }],
    ],
  };
}

export function deleteSecretPanel(name: string): { html: string; keyboard: Keyboard } {
  return {
    html: `Delete <code>${escapeHtml(name)}</code>?`,
    keyboard: [[{ text: "Delete", callback_data: `a:delyes:${name}` }, { text: "Cancel", callback_data: "a:secrets" }]],
  };
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
