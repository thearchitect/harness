// The keyboard on web: the shared keymap's keys (keymap.ts) turned into the workbench's actions. In
// the browser some keys belong to the browser (Ctrl+T); the desktop window has them all. Ctrl+C is
// never taken (copying); Ctrl+D closes the tab only from an empty field.

import { ACTIONS, TAB_GOTO_KEYS, type ActionId } from "#client/keymap.ts";
import { bracketedPaste, terminalKey } from "#client/terminal-keys.ts";

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

/** While a component or a terminal takes the keys: the workbench actions it leaves to the workbench. */
let capturedBy: { keeps: (action: ActionId) => boolean } | undefined;

function isField(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: string } | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/**
 * The workbench's keys. React Native Web's fields stop their keys from bubbling, so keys typed in a
 * field are taken on the way down (capture), the others on the way up, after the page's lists and
 * dialogs had them. Esc in a field is the field's (a dialog's, a list's filter).
 */
export function listenKeys(act: (action: ActionId) => void): () => void {
  const take = (event: KeyboardEvent, action: ActionId | undefined): void => {
    const target = event.target as { value?: unknown } | null;
    const typing = typeof target?.value === "string" && target.value !== "";
    if (action === "tabs.close" && typing) {
      // with text, the field deletes forward
    } else if (action !== undefined && !EDITOR_OWN.has(action)) {
      event.preventDefault();
      act(action);
    } else {
      // a key of the page, the editor or a field
    }
  };
  const down = (event: KeyboardEvent): void => {
    const action = actionOfKey(keyName(event));
    if (capturedBy !== undefined) {
      if (action !== undefined && capturedBy.keeps(action)) {
        take(event, action);
      } else {
        // the component's or the terminal's key (listenComponentKeys)
      }
    } else if (isField(event.target) && action !== "run.abort") {
      take(event, action);
    } else {
      // taken on the way up, after the page had it
    }
  };
  const up = (event: KeyboardEvent): void => {
    if (capturedBy !== undefined || (isField(event.target) && event.defaultPrevented)) {
      return; // a component's or a terminal's keys, or taken on the way down
    } else {
      take(event, actionOfKey(keyName(event)));
    }
  };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keydown", up);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keydown", up);
  };
}

/**
 * While an extension's component (or a session's terminal) is open every key is its own, as terminal
 * bytes (the workbench keeps tab switching, the panel and what `keep` names); pasted text arrives as
 * bracketed paste (where `bracketed` says the program takes it).
 */
export function listenComponentKeys(send: (bytes: string) => void, keep: (action: ActionId) => boolean = () => false, bracketed: () => boolean = () => true): () => void {
  const keeps = (action: ActionId): boolean => action.startsWith("tabs.") || action === "panel.toggle" || keep(action);
  const mine = { keeps };
  capturedBy = mine;
  const onKey = (event: KeyboardEvent): void => {
    const action = actionOfKey(keyName(event));
    const bytes = terminalKey({ key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
    if ((action !== undefined && keeps(action)) || bytes === undefined) {
      return; // the workbench's key, or none a terminal sends
    } else {
      event.preventDefault();
      event.stopPropagation();
      send(bytes);
    }
  };
  const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text !== "") {
      event.preventDefault();
      send(bracketed() ? bracketedPaste(text) : text);
    } else {
      // nothing as text
    }
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("paste", onPaste, true);
  return () => {
    capturedBy = capturedBy === mine ? undefined : capturedBy;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("paste", onPaste, true);
  };
}
