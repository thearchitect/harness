// Where harness runs and which keys do not reach it there: taken by the host (a browser's tab keys)
// or never sent (a terminal without the kitty protocol cannot tell Ctrl+Enter from Enter; a Mac
// terminal prints Option+letter as a character). The policy's test checks that every action has a
// key that arrives in every one of them, or is reached otherwise (`elsewhere`, with why).

export type Profile = {
  name: string;
  /** Keys that do not arrive (exact names). */
  lost: (key: string) => boolean;
  /** Actions no key of which arrives here, reached otherwise: why. */
  elsewhere: Record<string, string>;
};

const isAlt = (key: string): boolean => key.startsWith("alt+");

export const PROFILES: Profile[] = [
  {
    name: "TUI with the kitty protocol (Ghostty, kitty, WezTerm, foot)",
    lost: () => false,
    elsewhere: {},
  },
  {
    name: "TUI without it (tmux, xterm, Windows Terminal)",
    // Ctrl+Enter is Enter's byte; Ctrl+/ comes as 0x1f, which harness reads as Ctrl+/ (Ctrl+- is no key of harness)
    lost: (key) => key === "ctrl+enter" || /^ctrl\+\d$/.test(key),
    elsewhere: {},
  },
  {
    name: "TUI in macOS Terminal.app (Option prints characters)",
    lost: (key) => isAlt(key) || key === "ctrl+enter" || /^ctrl\+\d$/.test(key) || key === "ctrl+pageUp" || key === "ctrl+pageDown" || key === "ctrl+up" || key === "ctrl+down",
    elsewhere: {
      "editor.submit": "the panel's actions (Ctrl+\\, send); or Option as Meta in Terminal's settings",
      "tabs.next": "the strip (Ctrl+S, then ↑↓ Enter) and Ctrl+1…9",
      "tabs.prev": "the strip (Ctrl+S, then ↑↓ Enter) and Ctrl+1…9",
      "items.next": "the strip (Ctrl+S)",
      "items.prev": "the strip (Ctrl+S)",
      "tabs.goto.1": "the strip (Ctrl+S)",
    },
  },
  {
    name: "a browser tab",
    // the browser's own: new window/tab, close, tab switching, and on Linux and Windows Alt+1…9 too
    lost: (key) => ["ctrl+n", "ctrl+w", "ctrl+t", "ctrl+pageUp", "ctrl+pageDown"].includes(key) || /^(ctrl|alt)\+\d$/.test(key),
    elsewhere: { "tabs.goto.1": "the strip and Ctrl/Alt+PgUp/PgDn's neighbours; the panel's actions" },
  },
  {
    name: "the app's window (harness web-app)",
    lost: (key) => ["ctrl+n", "ctrl+w", "ctrl+t"].includes(key),
    elsewhere: {},
  },
  {
    name: "a phone with a keyboard",
    lost: () => false,
    elsewhere: {},
  },
];
