// The single-line field: the cursor moves with the keys, the text scrolls keeping a column for the
// cursor at the end (no jump while typing at the edge), the terminal's cursor marker while focused,
// a mask that draws bullets with the cursor among them. It reaches into pi-tui Input's cursor: a pi
// update that renames it fails here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { LineField } from "./line-field.ts";

/** The line as the screen shows it, with `|` where the cursor marker stands. */
function shown(field: LineField, width: number): string {
  const line = field.render(width)[0] ?? "";
  assert.equal(visibleWidth(line), width, "exactly the given width");
  return line
    .replace(CURSOR_MARKER, "|")
    .replace(/\x1b_pi:[^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

test("keys move the cursor; typing goes where it stands; changes are reported, moves are not", () => {
  const field = new LineField();
  const changes: string[] = [];
  field.onChange = (value) => changes.push(value);
  field.focused = true;
  for (const key of "abcd") field.handleInput(key);
  field.handleInput("\x1b[D"); // ←
  field.handleInput("\x1b[D");
  field.handleInput("X");
  assert.equal(field.value, "abXcd");
  field.handleInput("\x1b[H"); // Home
  field.handleInput("<");
  field.handleInput("\x1b[F"); // End
  field.handleInput(">");
  assert.equal(field.value, "<abXcd>");
  assert.equal(changes.at(-1), "<abXcd>");
  const count = changes.length;
  field.handleInput("\x1b[D");
  assert.equal(changes.length, count, "a move is no change");
  assert.match(shown(field, 20), /^<abXcd\|>/);
});

test("at the right edge the text does not jump: a column stays for the cursor", () => {
  const field = new LineField();
  field.focused = true;
  const width = 10;
  // nine characters fit with the cursor after them
  for (const key of "123456789") field.handleInput(key);
  assert.equal(shown(field, width).trimEnd(), "123456789|");
  // the tenth scrolls by exactly one: the cursor keeps the last column
  field.handleInput("0");
  assert.equal(shown(field, width), "234567890| ", "nine characters and the cursor's cell");
});

test("a value from outside puts the cursor at its end; unfocused there is no marker", () => {
  const field = new LineField({ placeholder: "title" });
  field.value = "name";
  field.focused = true;
  assert.match(shown(field, 12), /^name\|/);
  field.focused = false;
  assert.ok(!(field.render(12)[0] ?? "").includes(CURSOR_MARKER));
  field.value = "";
  assert.match(shown(field, 12), /^title/);
});

test("a mask draws a bullet per character with the cursor where it is", () => {
  const field = new LineField({ mask: "•" });
  field.focused = true;
  for (const key of "secret") field.handleInput(key);
  field.handleInput("\x1b[D");
  const line = shown(field, 12);
  assert.equal(line.includes("secret"), false);
  assert.match(line, /^•••••\|•/);
});
