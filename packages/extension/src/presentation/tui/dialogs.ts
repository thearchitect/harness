// The `choice` interaction and extensions' `pi-dialog`s in the TUI, in the editor's place: drawn by
// pi's own dialog components (a selector, an input, an editor; a confirmation is the selector with
// Yes and No, as pi asks it), so they look and answer the keys as in pi.

import { ExtensionEditorComponent, ExtensionInputComponent, ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ChoiceAnswer, ChoicePayload, PiDialogAnswer, PiDialogPayload } from "#protocol/interactions.ts";

/**
 * A choice: pi's selector over the options' titles (a description follows its title). The answer
 * is the chosen option's id.
 */
export function choiceDialog(tui: TUI, payload: ChoicePayload, done: (answer: ChoiceAnswer) => void): Component {
  const labels = payload.options.map((option) => (option.description !== undefined ? `${option.title} — ${option.description}` : option.title));
  const title = payload.message !== undefined && payload.message !== "" ? `${payload.title}\n${payload.message}` : payload.title;
  return new ExtensionSelectorComponent(
    title,
    labels,
    (label) => {
      const option = payload.options[labels.indexOf(label)];
      done(option !== undefined ? { id: option.id } : { cancelled: true });
    },
    () => done({ cancelled: true }),
    { tui },
  );
}

export function piDialog(tui: TUI, payload: PiDialogPayload, done: (answer: PiDialogAnswer) => void): Component {
  const method = payload.method;
  switch (method) {
    case "select":
      return new ExtensionSelectorComponent(payload.title, payload.options, (value) => done({ value }), () => done({ cancelled: true }), { tui });
    case "confirm":
      return new ExtensionSelectorComponent(`${payload.title}\n${payload.message}`, ["Yes", "No"], (value) => done({ confirmed: value === "Yes" }), () => done({ cancelled: true }), { tui });
    case "input":
      return new ExtensionInputComponent(payload.title, payload.placeholder, (value) => done({ value }), () => done({ cancelled: true }), { tui });
    case "editor":
      return new ExtensionEditorComponent(tui, getKeybindings() as never, payload.title, payload.prefill, (value) => done({ value }), () => done({ cancelled: true }));
    default:
      throw new Error(`unknown dialog: ${String(method satisfies never)}`);
  }
}
