// The rasterizer's contract (gate G7): what pi-tui writes becomes the right cell grid — colors,
// box drawing and braille one cell wide, wide glyphs two — and, with the bundle's browser, a PNG.

import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualTerminal } from "../drivers/terminal.ts";
import { bundledBrowser, gridHtml, screenshot } from "./rasterize.ts";

test("ANSI becomes cells: colors, widths of box drawing, braille and wide glyphs", async () => {
  const terminal = new VirtualTerminal(20, 3);
  terminal.write("\x1b[38;2;255;0;0mR\x1b[0m\x1b[48;5;21mB\x1b[0m\x1b[1mb\x1b[0m─│┌⠿✓◆漢x\r\n");
  terminal.write("\x1b[7mi\x1b[0m");
  await terminal.flushed();
  const [row, second] = terminal.cells();
  assert.ok(row !== undefined && second !== undefined);
  assert.equal(row[0]?.fg, "#ff0000");
  assert.equal(row[1]?.bg, "#0000ff");
  assert.equal(row[2]?.bold, true);
  assert.deepEqual(
    row.slice(3, 10).map((cell) => [cell.chars, cell.width]),
    [
      ["─", 1],
      ["│", 1],
      ["┌", 1],
      ["⠿", 1],
      ["✓", 1],
      ["◆", 1],
      ["漢", 2],
    ],
  );
  assert.equal(row[10]?.width, 0, "the second half of the wide glyph");
  assert.equal(row[11]?.chars, "x");
  assert.equal(second[0]?.inverse, true);
  assert.equal(terminal.text()[0], "RBb─│┌⠿✓◆漢x");
});

test("the HTML keeps one row per screen row; the bundle's browser draws it", { skip: bundledBrowser() === undefined ? "no bundle browser (HARNESS_MANIFEST)" : false }, async () => {
  const terminal = new VirtualTerminal(10, 2);
  terminal.write("ab\r\ncd");
  await terminal.flushed();
  const html = gridHtml(terminal.cells());
  assert.equal(html.match(/class="r"/g)?.length, 2);
  const png = await screenshot(html);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
});
