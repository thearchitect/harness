// Keys as a terminal sends them, for UIs that are no terminal (the app giving keys to an
// extension's component drawn in the agent): a key by its name (the DOM's KeyboardEvent.key) and
// modifiers becomes the bytes pi-tui reads; pasted text is wrapped as bracketed paste.

export type KeyPress = { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };

const NAMED: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Insert: "\x1b[2~",
};

/** The bytes for a key press; undefined for keys a terminal does not send (a lone modifier, F-keys). */
export function terminalKey(press: KeyPress): string | undefined {
  const { key } = press;
  let bytes: string | undefined;
  if (key === "Tab" && press.shift === true) {
    bytes = "\x1b[Z";
  } else if (NAMED[key] !== undefined) {
    bytes = NAMED[key];
  } else if (press.ctrl === true && key.length === 1 && /[a-z@\[\\\]^_ ]/i.test(key)) {
    // Ctrl+letter: the control character
    const code = key === " " ? 0 : key.toUpperCase().charCodeAt(0) - 64;
    bytes = String.fromCharCode(code);
  } else if (key.length >= 1 && [...key].length === 1 && press.ctrl !== true && press.meta !== true) {
    bytes = key;
  } else {
    bytes = undefined;
  }
  return bytes !== undefined && press.alt === true ? `\x1b${bytes}` : bytes;
}

/** Pasted text as a terminal with bracketed paste sends it. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
