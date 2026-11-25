// The actions of the workbench and their default keys, shared by every UI: the TUI maps terminal
// keys to these ids, the app maps its keys, clicks, gestures and menus to the same ids, and test
// drivers act by id. Key names follow pi-tui (`ctrl+enter`, `alt+1`, `ctrl+pageDown`).

export const ACTIONS = {
  "editor.submit": { keys: ["ctrl+enter", "alt+enter"], description: "Send the message (Alt+Enter where the terminal cannot tell Ctrl+Enter)" },
  "editor.newline": { keys: ["enter", "shift+enter", "ctrl+j"], description: "New line in the message" },
  "run.abort": { keys: ["escape"], description: "Stop the run (and clear a pending interaction's focus)" },
  "tabs.next": { keys: ["ctrl+pageDown"], description: "Next session tab" },
  "tabs.prev": { keys: ["ctrl+pageUp"], description: "Previous session tab" },
  "tabs.new": { keys: ["ctrl+t"], description: "New session" },
  "tabs.close": { keys: ["ctrl+w"], description: "Close the tab (the agent keeps running)" },
  "tabs.open": { keys: ["ctrl+o"], description: "Open a session" },
  "items.next": { keys: ["alt+down"], description: "Next item of the session (tasks, subagents)" },
  "items.prev": { keys: ["alt+up"], description: "Previous item of the session" },
  "panel.toggle": { keys: ["ctrl+\\"], description: "Harness panel: madness, simple, implementer, dependencies" },
  "model.select": { keys: ["ctrl+l"], description: "Choose the model" },
  "model.cycle": { keys: ["ctrl+p"], description: "Next model" },
  "thinking.cycle": { keys: ["shift+tab"], description: "Next thinking level" },
  "tools.expand": { keys: ["ctrl+e"], description: "Expand or collapse tool output" },
  "strip.tabs": { keys: ["alt+left"], description: "The keyboard into the session tabs (over the screen when it is too narrow for them); again or Esc: back" },
  "strip.items": { keys: ["alt+right"], description: "The keyboard into the session's items (over the screen when it is too narrow for them); again or Esc: back" },
  "transcript.search": { keys: ["ctrl+f"], description: "Search the transcript" },
  "app.quit": { keys: ["ctrl+q"], description: "Quit (agents keep running on their node)" },
} as const;

export type ActionId = keyof typeof ACTIONS | `tabs.goto.${number}`;

/** Alt+1…9 select tabs directly. */
export const TAB_GOTO_KEYS = Array.from({ length: 9 }, (_, index) => ({ key: `alt+${index + 1}`, action: `tabs.goto.${index + 1}` as ActionId }));

export function keysOf(action: keyof typeof ACTIONS): readonly string[] {
  return ACTIONS[action].keys;
}
