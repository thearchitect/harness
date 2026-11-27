// The one policy of the keyboard: a key in a mode either acts (a workbench action) or belongs to
// the mode's owner (the field, the dialog, the list, the terminal). Both UIs turn their key into its
// name (pi-tui's: `ctrl+n`, `alt+/`, `shift+tab`), ask `route`, and do what it says.

import { CHAT_ACTIONS, GLOBAL_ACTIONS, globalKeys, TAB_GOTO, type ActionId } from "./actions.ts";
import type { Mode } from "./modes.ts";

export type Route = { kind: "action"; action: ActionId } | { kind: "owner" };

/** Global keys: both variants of every global action and of Ctrl/Alt+1…9. */
const GLOBAL_KEYS: ReadonlyMap<string, ActionId> = new Map([
  ...Object.entries(GLOBAL_ACTIONS).flatMap(([action, spec]) => globalKeys(spec.key).map((key) => [key, action as ActionId] as const)),
  ...TAB_GOTO.flatMap((goto) => globalKeys(goto.key).map((key) => [key, goto.action] as const)),
]);

const CHAT_KEYS: ReadonlyMap<string, ActionId> = new Map(Object.entries(CHAT_ACTIONS).flatMap(([action, spec]) => spec.keys.map((key) => [key, action as ActionId] as const)));

/** The actions that mean something in the chat alone. */
const CHAT_ONLY = new Set<ActionId>(["clipboard.copy", "clipboard.paste"]);

/** Every key the policy may route to an action (the TUI matches a key's bytes against these). */
export function routedKeys(): string[] {
  return [...GLOBAL_KEYS.keys(), ...CHAT_KEYS.keys()];
}

export function route(mode: Mode, key: string | undefined): Route {
  const global = key !== undefined ? GLOBAL_KEYS.get(key) : undefined;
  const chat = key !== undefined ? CHAT_KEYS.get(key) : undefined;
  switch (mode.kind) {
    case "capture":
      // everything is the captor's but the terminal's way out, and the prompt editor's own key
      // (taken, and nothing happens: only the editor's exit closes it)
      return (mode.owner === "terminal" && global === "terminal.toggle") || (mode.owner === "prompt" && global === "prompt.edit") ? { kind: "action", action: global } : { kind: "owner" };
    case "chat":
      return global !== undefined ? { kind: "action", action: global } : chat !== undefined ? { kind: "action", action: chat } : { kind: "owner" };
    case "dialog":
    case "panel":
      return global !== undefined && !CHAT_ONLY.has(global) ? { kind: "action", action: global } : { kind: "owner" };
    default:
      throw new Error(`unknown mode: ${JSON.stringify(mode satisfies never)}`);
  }
}

/** The global action of a key in any mode but capture (the panel's list, hints). */
export function globalActionOf(key: string): ActionId | undefined {
  return GLOBAL_KEYS.get(key);
}
