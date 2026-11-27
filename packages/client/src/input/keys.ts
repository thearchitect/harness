// A key's name, the policy's (pi-tui's names: `ctrl+n`, `alt+/`, `shift+tab`, `ctrl+pageDown`), from
// what a browser reports. Letters, digits and punctuation come from the physical key (`code`), so
// Ctrl+N is Ctrl+N in any layout (a Russian one types a Cyrillic letter there). The TUI names keys by pi-tui
// (matchesKey, which reads the kitty protocol's base layout key the same way).

/** What a keydown carries, as far as naming it goes. */
export type DomKey = { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

const NAMED: Record<string, string> = {
  Escape: "escape",
  Enter: "enter",
  NumpadEnter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Space: "space",
};

const PUNCTUATION: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
};

/** The base of a key, without modifiers: by its physical place where it is a character key. */
function baseOf(event: DomKey): string | undefined {
  if (NAMED[event.code] !== undefined) {
    return NAMED[event.code];
  } else if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3).toLowerCase();
  } else if (/^Digit\d$/.test(event.code)) {
    return event.code.slice(5);
  } else if (PUNCTUATION[event.code] !== undefined) {
    return PUNCTUATION[event.code];
  } else if (NAMED[event.key] !== undefined) {
    return NAMED[event.key];
  } else if (event.key.length === 1) {
    return event.key.toLowerCase();
  } else {
    return undefined; // a modifier alone, a function key the policy does not use
  }
}

/** pi-tui's name of a keydown; Cmd counts as Ctrl (a Mac's Cmd+N is the workbench's Ctrl+N). */
export function domKeyName(event: DomKey): string | undefined {
  const base = baseOf(event);
  if (base === undefined) {
    return undefined;
  } else {
    // Shift names only keys without a character of their own (Shift+Tab, Shift+Enter): Shift+a is A
    const shift = event.shiftKey && (base.length > 1 || event.ctrlKey || event.metaKey || event.altKey) && base !== "/" && base !== "\\";
    return [event.ctrlKey || event.metaKey ? "ctrl" : "", event.altKey ? "alt" : "", shift ? "shift" : "", base].filter((part) => part !== "").join("+");
  }
}
