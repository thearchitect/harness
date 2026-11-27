// The keyboard on web: each keydown named by its physical key (input/keys.ts) and routed by the one
// policy (input/policy.ts) in the mode the window is in — an action of the workbench, or the key of
// whoever owns the keyboard now (the message field, a dialog, a list, a captor). Keys are looked at
// on the way down (React Native Web's fields keep theirs from bubbling); the browser's own (Ctrl+C
// copying a selection, Ctrl+V pasting) are left to it.

import type { ActionId } from "#client/input/actions.ts";
import { domKeyName } from "#client/input/keys.ts";
import { modeOf, type Capture, type ModeInputs } from "#client/input/modes.ts";
import { route } from "#client/input/policy.ts";
import { bracketedPaste, LEGACY, terminalKey, type KeyModes } from "#client/terminal-keys.ts";

/** The message field's own keys: sending and new lines are its handlers'. */
const FIELD_OWN = new Set<ActionId>(["editor.submit", "editor.newline"]);

/** Whether the keyboard is in the strip (its lists have the focus). */
function inStrip(): boolean {
  const focused = document.activeElement as HTMLElement | null;
  return focused?.closest('[aria-label="sessions"], [aria-label="hubs"], [aria-label="items"]') !== null && focused !== null;
}

/** Whether some text is selected (Ctrl+C then copies it, as the browser does). */
function selecting(): boolean {
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const inField = focused !== null && typeof focused.selectionStart === "number" && focused.selectionStart !== focused.selectionEnd;
  return inField || (window.getSelection()?.toString() ?? "") !== "";
}

/** The workbench's keys in the window's mode (`inputs`: the UI's state but the strip, found here). */
export function listenKeys(act: (action: ActionId) => void, inputs: () => Omit<ModeInputs, "strip">): () => void {
  const down = (event: KeyboardEvent): void => {
    const mode = modeOf({ ...inputs(), strip: inStrip() });
    const routed = route(mode, domKeyName(event));
    if (routed.kind === "owner") {
      return; // the field's, the dialog's, the list's, the captor's
    } else if (FIELD_OWN.has(routed.action) || (routed.action === "clipboard.copy" && event.ctrlKey && selecting()) || (routed.action === "clipboard.paste" && event.ctrlKey)) {
      return; // the field sends and breaks lines; the browser copies a selection and pastes
    } else {
      event.preventDefault();
      event.stopPropagation();
      act(routed.action);
    }
  };
  window.addEventListener("keydown", down, true);
  return () => window.removeEventListener("keydown", down, true);
}

/**
 * While a captor (an extension's component, the session's terminal) is open every key is its own,
 * as terminal bytes in the modes the program asked for (`modes`: the cursor keys' mode, the kitty
 * protocol), but its way out (listenKeys acts on that); pasted text arrives as bracketed paste where
 * `bracketed` says the program takes it.
 */
export function listenComponentKeys(send: (bytes: string) => void, owner: Capture, bracketed: () => boolean = () => true, modes: () => KeyModes = () => LEGACY): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const bytes = terminalKey({ key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }, modes());
    if (route({ kind: "capture", owner }, domKeyName(event)).kind === "action" || bytes === undefined) {
      return; // the way out, or no key a terminal sends
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
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("paste", onPaste, true);
  };
}
