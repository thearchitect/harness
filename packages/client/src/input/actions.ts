// The workbench's actions and their keys, one registry for every UI: the TUI and the app turn a key
// into an action through the policy (policy.ts), test drivers act by id, the panel lists them all.
//
// A global action has one key and answers to it with Ctrl and with Alt alike — wherever one of the
// two does not reach the client (a browser takes Ctrl+N, a Mac terminal prints Option+N), the other
// does; no other duplicates. The chat's own actions belong to the chat mode alone. Key names follow
// pi-tui (`ctrl+n`, `alt+pageDown`, `shift+tab`).

export type GlobalSpec = { key: string; description: string };

export const GLOBAL_ACTIONS = {
  "tabs.new": { key: "n", description: "New session" },
  "tabs.open": { key: "o", description: "Open a session" },
  "tabs.close": { key: "w", description: "Close the session's tab" },
  "tabs.next": { key: "pageDown", description: "Next session tab" },
  "tabs.prev": { key: "pageUp", description: "Previous session tab" },
  "items.next": { key: "down", description: "Next item of the session (tasks, subagents)" },
  "items.prev": { key: "up", description: "Previous item of the session" },
  "strip.tabs": { key: "s", description: "The keyboard into the strip: hubs, sessions, items; again or Esc: back" },
  "terminal.toggle": { key: "/", description: "The session's terminal over the main area, in its directory" },
  "panel.toggle": { key: "\\", description: "The panel: modes, the session, harness, every action" },
  "model.select": { key: "l", description: "Choose the model" },
  "model.cycle": { key: "p", description: "Next model" },
  "tools.expand": { key: "e", description: "Expand or collapse tool output" },
  "transcript.search": { key: "f", description: "Search the transcript" },
  "app.quit": { key: "q", description: "Quit (a hub this window holds stops with it: asked first while agents work or other windows use it)" },
  "clipboard.copy": { key: "c", description: "In the chat: clear the message" },
  "clipboard.paste": { key: "v", description: "In the chat: paste files, an image or text" },
} as const satisfies Record<string, GlobalSpec>;

/** The chat's own keys: sending, a new line, stopping the run, the thinking level. */
export const CHAT_ACTIONS = {
  "editor.submit": { keys: ["ctrl+enter", "alt+enter"], description: "Send the message (Alt+Enter where the terminal cannot tell Ctrl+Enter)" },
  "editor.newline": { keys: ["enter", "shift+enter"], description: "New line in the message" },
  "run.abort": { keys: ["escape"], description: "Stop the run" },
  "thinking.cycle": { keys: ["shift+tab"], description: "Next thinking level" },
} as const;

export type GlobalActionId = keyof typeof GLOBAL_ACTIONS;
export type ChatActionId = keyof typeof CHAT_ACTIONS;
export type ActionId = GlobalActionId | ChatActionId | `tabs.goto.${number}`;

/** Ctrl/Alt+1…9: the tab of that number. */
export const TAB_GOTO = Array.from({ length: 9 }, (_, index) => ({ key: String(index + 1), action: `tabs.goto.${index + 1}` as ActionId }));

/** The keys of a global action: its key with Ctrl and with Alt. */
export function globalKeys(key: string): [string, string] {
  return [`ctrl+${key}`, `alt+${key}`];
}

/** How a key reads in hints: `Ctrl/Alt+N`. */
export function hintOf(key: string): string {
  const names: Record<string, string> = { pageDown: "PgDn", pageUp: "PgUp", down: "↓", up: "↑" };
  return `Ctrl/Alt+${names[key] ?? key.toUpperCase()}`;
}

/** Every action with its keys and what it does, as the panel and the documentation list them. */
export function actionList(): { id: ActionId; keys: string; description: string }[] {
  return [
    ...Object.entries(GLOBAL_ACTIONS).map(([id, spec]) => ({ id: id as ActionId, keys: hintOf(spec.key), description: spec.description })),
    { id: "tabs.goto.1" as ActionId, keys: "Ctrl/Alt+1…9", description: "The tab of that number" },
    ...Object.entries(CHAT_ACTIONS).map(([id, spec]) => ({ id: id as ActionId, keys: spec.keys.join(", "), description: spec.description })),
  ];
}
