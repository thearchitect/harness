// Keys as a terminal sends them to the program inside it, for both clients: the TUI's keys (any form
// its own terminal reports — legacy bytes, the kitty protocol, with repeats) and the browser's
// become one key, and the key becomes the bytes the program asked for: arrows and Home/End in the
// application cursor mode (DECCKM) or not, the kitty protocol where the program pushed it, standard
// modifiers otherwise (`ESC [1;5A`). Pasted text is wrapped as bracketed paste.

/** A key: pi-tui's name of it (`up`, `pageDown`, `f5`, `enter`, a character) and its modifiers. */
export type Key = { name: string; ctrl: boolean; alt: boolean; shift: boolean };

/** What the program asked for of the keyboard. */
export type KeyModes = { applicationCursor: boolean; kitty: boolean };

/** What an extension's component (pi-tui in the agent) reads: legacy bytes, normal cursor keys. */
export const LEGACY: KeyModes = { applicationCursor: false, kitty: false };

/** Cursor keys: their final byte (CSI A / SS3 A). */
const CURSOR: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };

/** Keys sent as CSI n ~. */
const TILDE: Record<string, number> = { insert: 2, delete: 3, pageUp: 5, pageDown: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };

/** F1–F4: SS3 P…S without modifiers. */
const PF: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };

/** The kitty protocol's codes of keys that are no character. */
const KITTY_CODE: Record<string, number> = { escape: 27, enter: 13, tab: 9, backspace: 127, space: 32 };

/** The modifier parameter: 1 + Shift 1, Alt 2, Ctrl 4. */
function modifier(key: Key): number {
  return 1 + (key.shift ? 1 : 0) + (key.alt ? 2 : 0) + (key.ctrl ? 4 : 0);
}

/** A key from pi-tui's name (`ctrl+shift+up`, `alt+x`, `f5`). */
export function keyFromId(id: string): Key {
  const parts = id.split("+");
  // `+` and `ctrl++` name the plus key
  const name = id === "+" || id.endsWith("++") ? "+" : (parts.at(-1) ?? "");
  return { name, ctrl: parts.includes("ctrl"), alt: parts.includes("alt"), shift: parts.includes("shift") };
}

/** A character key with Ctrl: its control byte, where a terminal has one. */
function controlByte(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (/^[A-Z@\[\\\]^_]$/.test(upper)) {
    return String.fromCharCode(upper.charCodeAt(0) - 64);
  } else if (name === "/" || name === "-") {
    return "\x1f";
  } else if (name === "space" || name === " " || name === "2") {
    return "\x00";
  } else {
    return undefined;
  }
}

/** The bytes for a key in the modes the program asked for; undefined for a key a terminal does not send. */
export function encodeKey(key: Key, modes: KeyModes): string | undefined {
  const mod = modifier(key);
  const plain = mod === 1;
  const character = [...key.name].length === 1 ? key.name : key.name === "space" ? " " : undefined;
  if (CURSOR[key.name] !== undefined) {
    return plain ? `${modes.applicationCursor ? "\x1bO" : "\x1b["}${CURSOR[key.name]}` : `\x1b[1;${mod}${CURSOR[key.name]}`;
  } else if (TILDE[key.name] !== undefined) {
    return plain ? `\x1b[${TILDE[key.name]}~` : `\x1b[${TILDE[key.name]};${mod}~`;
  } else if (PF[key.name] !== undefined) {
    return plain ? `\x1bO${PF[key.name]}` : `\x1b[1;${mod}${PF[key.name]}`;
  } else if (modes.kitty && !plain && (KITTY_CODE[key.name] !== undefined || character !== undefined)) {
    // the program reads every modified key whole (the kitty protocol it pushed)
    const code = KITTY_CODE[key.name] ?? (character ?? "").toLowerCase().codePointAt(0) ?? 0;
    return `\x1b[${code};${mod}u`;
  } else if (key.name === "tab") {
    return key.shift ? "\x1b[Z" : key.alt ? "\x1b\t" : "\t";
  } else if (key.name === "enter" || key.name === "return") {
    return key.alt ? "\x1b\r" : "\r";
  } else if (key.name === "escape") {
    return key.alt ? "\x1b\x1b" : "\x1b";
  } else if (key.name === "backspace") {
    return `${key.alt ? "\x1b" : ""}${key.ctrl ? "\x08" : "\x7f"}`;
  } else if (character !== undefined) {
    const typed = key.shift && character.toUpperCase() !== character ? character.toUpperCase() : character;
    const bytes = key.ctrl ? controlByte(character) : typed;
    return bytes !== undefined ? `${key.alt ? "\x1b" : ""}${bytes}` : undefined;
  } else {
    return undefined; // a key a terminal sends nothing for
  }
}

/** A DOM key's name as pi-tui names it (`ArrowUp` → `up`, `F5` → `f5`, `a` → `a`). */
const DOM_NAMES: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowRight: "right",
  ArrowLeft: "left",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Insert: "insert",
  " ": "space",
};

export type KeyPress = { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };

/** A browser's key press as the program inside asks for it; undefined for keys a terminal does not send (a lone modifier, Cmd). */
export function terminalKey(press: KeyPress, modes: KeyModes = LEGACY): string | undefined {
  const name = DOM_NAMES[press.key] ?? (/^F([1-9]|1[0-2])$/.test(press.key) ? press.key.toLowerCase() : [...press.key].length === 1 ? press.key : undefined);
  if (name === undefined || press.meta === true) {
    return undefined;
  } else {
    // a character's Shift is in the character itself (A, !): only named keys carry it
    const shift = press.shift === true && [...name].length > 1;
    return encodeKey({ name, ctrl: press.ctrl === true, alt: press.alt === true, shift }, modes);
  }
}

/** Pasted text as a terminal with bracketed paste sends it. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
