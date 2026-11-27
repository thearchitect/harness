// Keys into the session's terminal: every form a terminal reports an arrow in (legacy, kitty with and
// without event types, repeats) becomes the arrow the program asked for (DECCKM or not, modifiers
// standard); releases are dropped; Home/End, Delete, PgUp/PgDn, F1–F12 with modifiers; the kitty
// protocol where the program pushed it; pasted text bracketed only when asked; the browser alike.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { encodeKey, keyFromId, LEGACY, terminalKey } from "#client/terminal-keys.ts";
import { shellBytes } from "./terminal-view.ts";

after(() => setKittyProtocolActive(false));

const NORMAL = { applicationCursor: false, kitty: false, bracketedPaste: false };
const APPLICATION = { ...NORMAL, applicationCursor: true };

test("every form of an arrow is the arrow; repeats type, releases do not", () => {
  setKittyProtocolActive(true);
  for (const form of ["\x1b[A", "\x1bOA", "\x1b[1;1A", "\x1b[1;1:1A", "\x1b[1;1:2A"]) {
    assert.equal(shellBytes(form, NORMAL), "\x1b[A", JSON.stringify(form));
    assert.equal(shellBytes(form, APPLICATION), "\x1bOA", `${JSON.stringify(form)} in DECCKM`);
  }
  assert.equal(shellBytes("\x1b[1;1:3A", NORMAL), "", "a release");
  assert.equal(shellBytes("\x1b[1;5A", NORMAL), "\x1b[1;5A", "Ctrl+↑");
  assert.equal(shellBytes("\x1b[1;5:2A", APPLICATION), "\x1b[1;5A", "Ctrl+↑ held: modifiers are never SS3");
  assert.equal(shellBytes("\x1b[99;5u", NORMAL), "\x03", "Ctrl+C");
  assert.equal(shellBytes("\x1b[27u", NORMAL), "\x1b", "Esc");
  assert.equal(shellBytes("\x1b[97u", NORMAL), "a");
  assert.equal(shellBytes("\x1b[1090::110u", NORMAL), "т", "a Russian layout types its letter");
  setKittyProtocolActive(false);
  assert.equal(shellBytes("\x1b[A", NORMAL), "\x1b[A");
  assert.equal(shellBytes("\x03", NORMAL), "\x03");
  assert.equal(shellBytes("\x1c", NORMAL), "\x1c", "Ctrl+\\ is the shell's");
  assert.equal(shellBytes("é", NORMAL), "é");
  assert.equal(shellBytes("+", NORMAL), "+");
  assert.equal(encodeKey(keyFromId("+"), LEGACY), "+");
});

test("the named keys with and without modifiers", () => {
  const key = (id: string, modes = LEGACY): string | undefined => encodeKey(keyFromId(id), modes);
  assert.equal(key("home"), "\x1b[H");
  assert.equal(key("end", { applicationCursor: true, kitty: false }), "\x1bOF");
  assert.equal(key("shift+end"), "\x1b[1;2F");
  assert.equal(key("delete"), "\x1b[3~");
  assert.equal(key("ctrl+delete"), "\x1b[3;5~");
  assert.equal(key("pageUp"), "\x1b[5~");
  assert.equal(key("shift+pageDown"), "\x1b[6;2~");
  assert.equal(key("f1"), "\x1bOP");
  assert.equal(key("ctrl+f4"), "\x1b[1;5S");
  assert.equal(key("f5"), "\x1b[15~");
  assert.equal(key("alt+f12"), "\x1b[24;3~");
  assert.equal(key("shift+tab"), "\x1b[Z");
  assert.equal(key("alt+enter"), "\x1b\r");
  assert.equal(key("ctrl+backspace"), "\x08");
  assert.equal(key("alt+backspace"), "\x1b\x7f");
  assert.equal(key("ctrl+/"), "\x1f");
  assert.equal(key("alt+x"), "\x1bx");
  assert.equal(key("ctrl+alt+c"), "\x1b\x03");
});

test("the kitty protocol the program pushed: modified keys come whole", () => {
  const kitty = { applicationCursor: false, kitty: true };
  assert.equal(encodeKey(keyFromId("ctrl+c"), kitty), "\x1b[99;5u");
  assert.equal(encodeKey(keyFromId("shift+enter"), kitty), "\x1b[13;2u");
  assert.equal(encodeKey(keyFromId("ctrl+up"), kitty), "\x1b[1;5A");
  assert.equal(encodeKey(keyFromId("a"), kitty), "a", "plain text stays text");
});

test("pasted text is bracketed only where the program asked", () => {
  const paste = "\x1b[200~two\nlines\x1b[201~";
  assert.equal(shellBytes(paste, NORMAL), "two\nlines");
  assert.equal(shellBytes(paste, { ...NORMAL, bracketedPaste: true }), paste);
});

test("the browser's keys alike", () => {
  assert.equal(terminalKey({ key: "ArrowUp" }, { applicationCursor: true, kitty: false }), "\x1bOA");
  assert.equal(terminalKey({ key: "ArrowLeft", ctrl: true }), "\x1b[1;5D");
  assert.equal(terminalKey({ key: "F5" }), "\x1b[15~");
  assert.equal(terminalKey({ key: "A", shift: true }), "A");
  assert.equal(terminalKey({ key: "Tab", shift: true }), "\x1b[Z");
  assert.equal(terminalKey({ key: "Meta" }), undefined);
});
