// ANSI lines as styled spans and keys as terminal bytes: what the app needs to show an extension's
// component and type into it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { color256, parseAnsiLine } from "./ansi.ts";
import { bracketedPaste, terminalKey } from "./terminal-keys.ts";

test("SGR: the 16, 256 and truecolor colors, the styles, resets", () => {
  assert.deepEqual(parseAnsiLine("plain").spans, [{ text: "plain", style: {} }]);
  assert.deepEqual(parseAnsiLine("\x1b[31mred\x1b[0m back").spans, [
    { text: "red", style: { fg: "#cd0000" } },
    { text: " back", style: {} },
  ]);
  assert.deepEqual(parseAnsiLine("\x1b[1;3;4;7mx\x1b[22;23mz").spans, [
    { text: "x", style: { bold: true, italic: true, underline: true, inverse: true } },
    { text: "z", style: { underline: true, inverse: true } },
  ]);
  assert.deepEqual(parseAnsiLine("\x1b[38;5;196ma\x1b[48;2;1;2;3mb\x1b[39;49mc").spans, [
    { text: "a", style: { fg: color256(196) } },
    { text: "b", style: { fg: "#ff0000", bg: "#010203" } },
    { text: "c", style: {} },
  ]);
  assert.equal(color256(196), "#ff0000");
  assert.equal(color256(244), "#808080");
  assert.deepEqual(parseAnsiLine("\x1b[2mdim\x1b[m").spans, [{ text: "dim", style: { dim: true } }]);
});

test("OSC 8 links (BEL and ST), pi-tui's markers dropped, its cursor marker as a column", () => {
  assert.deepEqual(parseAnsiLine("see \x1b]8;;https://x.example/a\x07here\x1b]8;;\x07 now").spans, [
    { text: "see ", style: {} },
    { text: "here", style: { link: "https://x.example/a" } },
    { text: " now", style: {} },
  ]);
  assert.deepEqual(parseAnsiLine("\x1b]8;;https://y\x1b\\y\x1b]8;;\x1b\\").spans, [{ text: "y", style: { link: "https://y" } }]);
  assert.deepEqual(parseAnsiLine("ab\x1b_pi:c\x07cd\x1b_pi:other\x07"), { spans: [{ text: "abcd", style: {} }], cursor: 2 });
  assert.deepEqual(parseAnsiLine("\x1b[2Kx").spans, [{ text: "x", style: {} }], "other CSI dropped");
});

test("keys as terminal bytes; paste bracketed", () => {
  assert.equal(terminalKey({ key: "ArrowUp" }), "\x1b[A");
  assert.equal(terminalKey({ key: "Enter" }), "\r");
  assert.equal(terminalKey({ key: "Escape" }), "\x1b");
  assert.equal(terminalKey({ key: "Tab", shift: true }), "\x1b[Z");
  assert.equal(terminalKey({ key: "Backspace" }), "\x7f");
  assert.equal(terminalKey({ key: "c", ctrl: true }), "\x03");
  assert.equal(terminalKey({ key: "x", alt: true }), "\x1bx");
  assert.equal(terminalKey({ key: "é" }), "é");
  assert.equal(terminalKey({ key: "Shift" }), undefined);
  assert.equal(terminalKey({ key: "v", meta: true }), undefined);
  assert.equal(bracketedPaste("a\nb"), "\x1b[200~a\nb\x1b[201~");
});
