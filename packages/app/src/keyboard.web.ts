// The keyboard on web: the shared keymap's keys (keymap.ts) turned into the workbench's actions. In
// the browser some keys belong to the browser (Ctrl+W, Ctrl+T); the desktop window has them all.

import { ACTIONS, TAB_GOTO_KEYS, type ActionId } from "#client/keymap.ts";

/** pi-tui's key name of a keydown: `ctrl+t`, `alt+1`, `ctrl+pageDown`, `escape`, `shift+tab`. */
export function keyName(event: KeyboardEvent): string {
  const names: Record<string, string> = { Escape: "escape", Enter: "enter", Tab: "tab", PageUp: "pageUp", PageDown: "pageDown", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const base = names[event.key] ?? (event.code.startsWith("Digit") ? event.code.slice(5) : event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
  return [event.ctrlKey || event.metaKey ? "ctrl" : "", event.altKey ? "alt" : "", event.shiftKey && base.length > 1 ? "shift" : "", base].filter((part) => part !== "").join("+");
}

export function actionOfKey(name: string): ActionId | undefined {
  const goto = TAB_GOTO_KEYS.find((candidate) => candidate.key === name);
  if (goto !== undefined) {
    return goto.action;
  } else {
    const found = Object.entries(ACTIONS).find(([, spec]) => (spec.keys as readonly string[]).includes(name));
    return found?.[0] as ActionId | undefined;
  }
}

/** Actions the editor handles itself (sending, new lines) are not taken here. */
const EDITOR_OWN = new Set<ActionId>(["editor.submit", "editor.newline"]);

export function listenKeys(act: (action: ActionId) => void): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const action = actionOfKey(keyName(event));
    if (action !== undefined && !EDITOR_OWN.has(action)) {
      event.preventDefault();
      act(action);
    } else {
      // a key of the page, the editor or a field
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
