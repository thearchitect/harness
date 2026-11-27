// The chat's field: the cursor keeps its lines above and below while the text has them, and comes
// to the edge at the text's ends; completion shows above the field under one titled line.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import { ChatEditor } from "./chat-editor.ts";

/** A terminal of 20 rows: the field shows at most 6 lines (30%). */
function editor(scrollOff: number): ChatEditor {
  const tui = { terminal: { rows: 20, columns: 40 }, requestRender: () => undefined } as unknown as TUI;
  const plain = (text: string): string => text;
  const field = new ChatEditor(
    tui,
    { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } },
    { border: plain, dim: plain, scrollOff: () => scrollOff },
  );
  field.focused = true;
  return field;
}

/** The text lines shown (between the field's two lines), the cursor's one marked. */
function shown(field: ChatEditor): string[] {
  const lines = field.render(40);
  const plain = (line: string): string =>
    line
      .replace(CURSOR_MARKER, "")
      .replace(/\x1b_pi:[^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trim();
  return lines.slice(1, -1).map((line) => (line.includes(CURSOR_MARKER) ? `>${plain(line)}` : plain(line)));
}

test("the cursor keeps two lines above and below while the text has them; at its ends it comes to the edge", () => {
  const field = editor(2);
  field.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
  // at the end: the last six lines, the cursor on the last
  assert.deepEqual(shown(field).at(-1), ">line 19");
  // up three: the window stays (the cursor on its 3rd line from the bottom)
  for (let step = 0; step < 2; step += 1) field.handleInput("\x1b[A");
  assert.deepEqual(shown(field), ["line 14", "line 15", "line 16", ">line 17", "line 18", "line 19"]);
  // up one more: two lines stay below the cursor, the window follows
  field.handleInput("\x1b[A");
  assert.deepEqual(shown(field), ["line 14", "line 15", ">line 16", "line 17", "line 18", "line 19"], "two lines below the cursor, the window still");
  field.handleInput("\x1b[A");
  field.handleInput("\x1b[A");
  assert.deepEqual(shown(field), ["line 12", "line 13", ">line 14", "line 15", "line 16", "line 17"], "two lines above: the window follows");
  // up to the first line: the cursor at the top edge
  for (let step = 0; step < 15; step += 1) field.handleInput("\x1b[A");
  assert.equal(shown(field)[0], ">line 0");
});
