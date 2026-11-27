// Who owns the keyboard: exactly one mode at a time.
//   chat     a session is open: typing and editing in its field, its own keys (actions.ts CHAT_ACTIONS)
//   dialog   something asks in the editor's place (a question, a login, a choice, a list, the folder
//            of a new session): its keys are its own
//   panel    the panel, or the keyboard in the strip
//   capture  the terminal, the prompt editor, an extension's component: every key is theirs but the
//            one that leaves (the terminal's own toggle; the others leave by themselves)
// Global actions act in every mode but capture.

export type Capture = "terminal" | "prompt" | "component";

export type Mode = { kind: "chat" } | { kind: "dialog" } | { kind: "panel" } | { kind: "capture"; owner: Capture };

/** What the UI knows of itself; `input` is the workbench's (Screen.input). */
export type ModeInputs = {
  input: "editor" | "dialog" | "picker" | "component" | "search" | "task" | "subagent" | "newSession";
  panel: boolean;
  strip: boolean;
  terminal: boolean;
  prompt: boolean;
};

export function modeOf(inputs: ModeInputs): Mode {
  if (inputs.terminal) {
    return { kind: "capture", owner: "terminal" };
  } else if (inputs.prompt) {
    return { kind: "capture", owner: "prompt" };
  } else if (inputs.input === "component") {
    return { kind: "capture", owner: "component" };
  } else if (inputs.panel || inputs.strip) {
    return { kind: "panel" };
  } else if (inputs.input === "dialog" || inputs.input === "picker" || inputs.input === "newSession" || inputs.input === "search") {
    return { kind: "dialog" };
  } else {
    return { kind: "chat" };
  }
}
