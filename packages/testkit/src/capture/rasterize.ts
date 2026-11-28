// Screen captures of a terminal: the cell grid becomes HTML (one span per run of equal style, a
// monospace font, the cells' own colors), and the bundle's browser draws it into a PNG. The text
// and the ANSI go next to it (screen.txt, screen.ansi): captures are for people reviewing a run;
// test verdicts never depend on pixels.

import { readFileSync } from "node:fs";
import type { Cell } from "../drivers/terminal.ts";

/** The terminal's own colors where a cell has none: a dark terminal's, or a light one's (the light theme is for a light terminal). */
export type TerminalColors = { fg: string; bg: string };
export const DARK_TERMINAL: TerminalColors = { fg: "#d4d4d4", bg: "#1e1e1e" };
export const LIGHT_TERMINAL: TerminalColors = { fg: "#1f2328", bg: "#ffffff" };

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function style(cell: Cell, colors: TerminalColors): string {
  const fg = cell.inverse ? (cell.bg ?? colors.bg) : (cell.fg ?? colors.fg);
  const bg = cell.inverse ? (cell.fg ?? colors.fg) : cell.bg;
  return [
    `color:${fg}`,
    bg !== undefined ? `background:${bg}` : "",
    cell.bold ? "font-weight:bold" : "",
    cell.italic ? "font-style:italic" : "",
    cell.dim ? "opacity:.6" : "",
    cell.underline ? "text-decoration:underline" : "",
  ]
    .filter((part) => part !== "")
    .join(";");
}

/** The grid as an HTML page: every row exactly `columns` cells wide (wide glyphs take two). */
export function gridHtml(grid: Cell[][], options: { fontFamily?: string; fontSize?: number; colors?: TerminalColors } = {}): string {
  const colors = options.colors ?? DARK_TERMINAL;
  const rows = grid.map((row) => {
    let html = "";
    let run = "";
    let runStyle = "";
    for (const cell of row) {
      if (cell.width === 0) {
        continue; // the second half of a wide glyph
      } else {
        const cellStyle = style(cell, colors);
        const chars = cell.chars === "" ? " " : cell.chars;
        const text = cell.width === 2 ? `<span class="w">${escape(chars)}</span>` : escape(chars);
        if (cellStyle === runStyle) {
          run += text;
        } else {
          html += run !== "" ? `<span style="${runStyle}">${run}</span>` : "";
          run = text;
          runStyle = cellStyle;
        }
      }
    }
    html += run !== "" ? `<span style="${runStyle}">${run}</span>` : "";
    return `<div class="r">${html}</div>`;
  });
  const size = options.fontSize ?? 14;
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${colors.bg}}
.s{display:inline-block;padding:4px;font-family:${options.fontFamily ?? "'JetBrains Mono','DejaVu Sans Mono',monospace"};font-size:${size}px;line-height:1.2;white-space:pre}
.r{height:${Math.round(size * 1.2)}px}
.w{display:inline-block;width:2ch;overflow:hidden}
</style><div class="s">${rows.join("")}</div>`;
}

/** The bundle's browser (manifest bin.browser), or undefined outside a bundle. */
export function bundledBrowser(): string | undefined {
  const manifest = process.env.HARNESS_MANIFEST;
  if (manifest === undefined || manifest === "") {
    return undefined;
  } else {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { browser?: string } }).bin?.browser;
  }
}

/** Draws HTML into a PNG with the bundle's browser; one browser per call (captures are rare). */
export async function screenshot(html: string): Promise<Buffer> {
  const executablePath = bundledBrowser();
  if (executablePath === undefined) {
    throw new Error("no browser: screenshots need the bundle's (HARNESS_MANIFEST)");
  } else {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--font-render-hinting=none", "--force-color-profile=srgb"] });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      await page.setContent(html);
      return await page.locator(".s").screenshot();
    } finally {
      await browser.close();
    }
  }
}
