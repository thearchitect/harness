/**
 * The inline panels that stay in the chat: /close's confirmation, /login's
 * providers, /secrets. They are posted as the last message of the chat and
 * edited in place while the user navigates; the outcome replaces the panel's
 * text. Everything else is chosen in the Mini App.
 *
 * callback_data: `s:<action>[:<arg>]` (agent), `a:<action>[:<arg>]` (account);
 * Telegram allows 64 bytes.
 */

import type { Keyboard } from "./outbox.ts";
import { escapeHtml } from "./render.ts";

const CANCEL = { text: "Cancel", callback_data: "s:dismiss" };

export function closePanel(dir: string): { html: string; keyboard: Keyboard } {
  return {
    html: `Close the agent in ${escapeHtml(dir)}? Its session stays in the history.`,
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
