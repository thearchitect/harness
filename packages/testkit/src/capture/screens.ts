// Screens and their baselines (tests/fixtures/screens/): what the product draws is compared with
// what was reviewed and accepted, and checked against the rules of layout.
//
//   TUI: the cell grid — each row's text and its runs of style (colors, bold, dim…) — after the
//   values that change from run to run (temporary paths, ids, times, costs, sizes) are written as
//   placeholders of the same width; equal or not, cell by cell. A PNG of it goes to the sheet.
//   Web: a PNG of the page, the same values replaced in its text first; pixels compared with a
//   small tolerance (a channel off by more than 24, more than 0.2% of the pixels).
//
// A mismatch writes the new screen and its difference next to the baseline in the report and
// fails; HARNESS_UPDATE_SCREENS=1 writes the new screens as the baselines (after looking at them).
// The rules of layout are checked on every screen; a violation fails unless it is listed in
// known-issues.json (reviewed findings waiting for their fix). The sheet (index.html and sheet.png)
// shows every screen of the run, the TUI's and the web's side by side, for people to look at.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Page } from "playwright-core";
import type { Cell } from "../drivers/terminal.ts";
import { gridHtml, screenshot, type TerminalColors } from "./rasterize.ts";

/** Values that change from run to run, each written as a placeholder of the same width. */
const VOLATILE: [RegExp, (match: string) => string][] = [
  // a stand's root (STAND_ROOT_WIDTH wide wherever the temporary directory is)
  // (its padding of dashes known, its random end may be cut short by a narrow screen)
  [/\/[\w./-]*?\/hs-(?:-+[A-Za-z0-9]{0,6}|[A-Za-z0-9]{6})/g, (root) => "~".repeat(root.length)],
  // session ids, whole or cut short by a narrow screen
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]*/g, (id) => id.replace(/[0-9a-f]/g, "x")],
  [/\ba\d+-[0-9a-f]{4}\b/g, (id) => id.replace(/-[0-9a-f]{4}$/, "-xxxx")],
  [/\b\d{4}-\d{2}-\d{2}\b/g, () => "2000-01-01"],
  // times, whole or cut short by a narrow screen
  [/\b\d{1,2}:\d{1,2}(:\d{0,2})?/g, (time) => time.replace(/\d/g, "0")],
  [/\b\d+(\.\d+)?(ms|s|m|h|d)\b/g, (span) => span.replace(/\d/g, "0")],
  [/\$\d+\.\d+/g, (cost) => cost.replace(/\d/g, "0")],
  [/\b\d+(\.\d+)?[KkMm]?\s?\(\d+%\)/g, (size) => size.replace(/\d/g, "0")],
  [/\b\d{1,3}%/g, (share) => share.replace(/\d/g, "0")],
  [/\b\d+ (tokens?|lines?|entries|records)\b/g, (count) => count.replace(/\d/g, "0")],
];

export function normalizeText(text: string): string {
  return VOLATILE.reduce((current, [pattern, replace]) => current.replace(pattern, replace), text);
}

/** A TUI screen as compared: each row's normalized text and its style runs (`style*count`). */
export type GridSnapshot = { columns: number; rows: string[]; styles: string[] };

export function gridSnapshot(cells: Cell[][]): GridSnapshot {
  const styleOf = (cell: Cell): string => [cell.fg ?? "-", cell.bg ?? "-", cell.bold ? "b" : "", cell.dim ? "d" : "", cell.italic ? "i" : "", cell.underline ? "u" : "", cell.inverse ? "r" : ""].join("/");
  return {
    columns: cells[0]?.length ?? 0,
    rows: cells.map((row) => normalizeText(row.map((cell) => (cell.width === 0 ? "" : cell.chars === "" ? " " : cell.chars)).join("")).replace(/\s+$/, "")),
    styles: cells.map((row) => {
      const runs: string[] = [];
      let last = "";
      let count = 0;
      for (const cell of row) {
        const style = styleOf(cell);
        if (style === last) {
          count += 1;
        } else {
          if (count > 0) {
            runs.push(`${last}*${count}`);
          } else {
            // the row's first cell
          }
          last = style;
          count = 1;
        }
      }
      runs.push(`${last}*${count}`);
      return runs.join(" ");
    }),
  };
}

/** The rules of layout on a TUI screen: closed frames, nothing a program forgot to format. */
export function tuiRules(snapshot: GridSnapshot): string[] {
  const problems: string[] = [];
  const rows = snapshot.rows.map((row) => [...row]);
  rows.forEach((row, y) => {
    row.forEach((char, x) => {
      if (char === "╭") {
        const right = row.indexOf("╮", x + 1);
        const bottom = rows.findIndex((candidate, index) => index > y && candidate[x] === "╰");
        if (right === -1) {
          problems.push(`frame: the corner ╭ at ${x},${y} has no ╮ on its row`);
        } else if (bottom === -1) {
          problems.push(`frame: the corner ╭ at ${x},${y} has no ╰ under it`);
        } else if (rows[bottom]?.[right] !== "╯") {
          problems.push(`frame: the frame from ${x},${y} to ${right},${bottom} has no ╯`);
        } else {
          for (let side = y + 1; side < bottom; side += 1) {
            if (rows[side]?.[x] !== "│" || rows[side]?.[right] !== "│") {
              problems.push(`frame: the frame from ${x},${y} to ${right},${bottom} is broken at row ${side}`);
              break;
            } else {
              // its sides go on
            }
          }
        }
      } else {
        // not a frame's corner
      }
    });
  });
  const text = snapshot.rows.join("\n");
  for (const leak of ["undefined", "NaN", "[object Object]"]) {
    if (text.includes(leak)) {
      problems.push(`text: "${leak}" on the screen`);
    } else {
      // not there
    }
  }
  return problems;
}

/** The rules of layout on a page: nothing wider than the window, text readable against its background (WCAG AA). */
export async function webRules(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      problems.push(`overflow: the page is ${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px window`);
    } else {
      // it fits
    }
    const parse = (color: string): [number, number, number, number] | undefined => {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color);
      return match !== null ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] !== undefined ? Number(match[4]) : 1] : undefined;
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const background = (element: Element | null): [number, number, number, number] => {
      for (let current = element; current !== null; current = current.parentElement) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color !== undefined && color[3] > 0.5) {
          return color;
        } else {
          // transparent: the parent's shows
        }
      }
      return [0, 0, 0, 1];
    };
    const seen = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const element = node.parentElement;
      const text = (node.textContent ?? "").trim();
      if (element === null || text === "" || element.getClientRects().length === 0) {
        continue; // no visible text
      } else {
        const style = getComputedStyle(element);
        const fg = parse(style.color);
        if (fg === undefined || Number(style.opacity) === 0 || style.visibility === "hidden") {
          continue;
        } else {
          const bg = background(element);
          const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
          const ratio = (light + 0.05) / (dark + 0.05);
          const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
          const needed = large ? 3 : 4.5;
          const key = `${style.color} on ${getComputedStyle(element).backgroundColor}`;
          if (ratio < needed && !seen.has(key)) {
            seen.add(key);
            problems.push(`contrast: ${ratio.toFixed(2)} < ${needed} for "${text.slice(0, 24)}" (${style.color} on rgb(${bg.slice(0, 3).join(", ")}))`);
          } else {
            // readable, or this pair is reported already
          }
        }
      }
    }
    return problems;
  });
}

/** The page's volatile values written as placeholders, so its pixels compare between runs. */
async function normalizePage(page: Page): Promise<void> {
  await page.evaluate((patterns: [string, string, string][]) => {
    const rules = patterns.map(([source, flags, fill]) => ({ pattern: new RegExp(source, flags), fill }));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      let text = node.textContent ?? "";
      // digits become 0 and letters x: the same width, the same on every run
      for (const rule of rules) {
        text = text.replace(rule.pattern, (match) => (rule.fill !== "" ? rule.fill.repeat(match.length) : match.replace(/\d/g, "0").replace(/[A-Za-z]/g, "x")));
      }
      if (text !== node.textContent) {
        node.textContent = text;
      } else {
        // nothing volatile here
      }
    }
    for (const field of document.querySelectorAll("textarea, input")) {
      (field as HTMLInputElement).style.caretColor = "transparent";
    }
    // a replacement that fills the match with one character (a stand's root) goes as that character
  }, VOLATILE.map(([pattern, replace]) => [pattern.source, pattern.flags, replace("ab") === "~~" ? "~" : ""] as [string, string, string]));
}

/** How many pixels differ (a channel off by more than 24), and their picture. */
function comparePng(baseline: Buffer, actual: Buffer): { differ: number; total: number; diff: Buffer | undefined } {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return { differ: Number.POSITIVE_INFINITY, total: b.width * b.height, diff: undefined };
  } else {
    const out = new PNG({ width: a.width, height: a.height });
    let differ = 0;
    for (let index = 0; index < a.data.length; index += 4) {
      const off = Math.max(Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0)), Math.abs((a.data[index + 1] ?? 0) - (b.data[index + 1] ?? 0)), Math.abs((a.data[index + 2] ?? 0) - (b.data[index + 2] ?? 0)));
      const different = off > 24;
      differ += different ? 1 : 0;
      out.data[index] = different ? 255 : Math.round((b.data[index] ?? 0) / 3);
      out.data[index + 1] = different ? 0 : Math.round((b.data[index + 1] ?? 0) / 3);
      out.data[index + 2] = different ? 0 : Math.round((b.data[index + 2] ?? 0) / 3);
      out.data[index + 3] = 255;
    }
    return { differ, total: a.width * a.height, diff: PNG.sync.write(out) };
  }
}

type Shot = { name: string; client: "tui" | "web"; png: string; problems: string[]; changed: boolean };

export type ScreenBookOptions = {
  /** The baselines' directory (tests/fixtures/screens/<suite>). */
  baselines: string;
  /** Where this run's screens, differences and the sheet go. */
  report: string;
  update?: boolean;
  /** The terminal the TUI's screens are drawn in (its own colors where a cell has none). */
  terminal?: TerminalColors;
};

export class ScreenBook {
  private readonly options: ScreenBookOptions;
  private readonly shots: Shot[] = [];
  private readonly known: Set<string>;

  constructor(options: ScreenBookOptions) {
    this.options = options;
    mkdirSync(options.report, { recursive: true });
    mkdirSync(options.baselines, { recursive: true });
    const knownFile = join(options.baselines, "known-issues.json");
    this.known = new Set(existsSync(knownFile) ? (JSON.parse(readFileSync(knownFile, "utf8")) as string[]) : []);
  }

  private get updating(): boolean {
    return this.options.update ?? process.env.HARNESS_UPDATE_SCREENS === "1";
  }

  /** A TUI screen: compared with its baseline, checked by the rules, drawn for the sheet. */
  async tui(name: string, cells: Cell[][]): Promise<void> {
    const snapshot = gridSnapshot(cells);
    const file = `${name}.tui`;
    const baseline = join(this.options.baselines, `${file}.json`);
    const actual = `${JSON.stringify(snapshot, null, 1)}\n`;
    const png = join(this.options.report, `${file}.png`);
    writeFileSync(png, await screenshot(gridHtml(cells, { ...(this.options.terminal !== undefined ? { colors: this.options.terminal } : {}) })));
    const problems: string[] = [];
    let changed = false;
    if (this.updating || !existsSync(baseline)) {
      writeFileSync(baseline, actual);
      problems.push(...(this.updating ? [] : [`${file}: no baseline yet (written: look at it and commit it)`]));
    } else if (readFileSync(baseline, "utf8") !== actual) {
      changed = true;
      writeFileSync(join(this.options.report, `${file}.json`), actual);
      const before = JSON.parse(readFileSync(baseline, "utf8")) as GridSnapshot;
      const rows = snapshot.rows.flatMap((row, index) => (row !== before.rows[index] || snapshot.styles[index] !== before.styles[index] ? [index] : []));
      problems.push(`${file}: differs from its baseline in rows ${rows.slice(0, 12).join(", ")}${rows.length > 12 ? "…" : ""}${rows[0] !== undefined ? `\n  was: ${before.rows[rows[0]] ?? ""}\n  now: ${snapshot.rows[rows[0]] ?? ""}` : ""}`);
    } else {
      // as reviewed
    }
    problems.push(...this.unknown(file, tuiRules(snapshot)));
    this.shots.push({ name, client: "tui", png, problems, changed });
  }

  /** A web page: its pixels compared with the baseline, its layout checked, kept for the sheet. */
  async web(name: string, page: Page): Promise<void> {
    await normalizePage(page);
    const file = `${name}.web`;
    const baseline = join(this.options.baselines, `${file}.png`);
    const png = join(this.options.report, `${file}.png`);
    const picture = await page.screenshot({ animations: "disabled", caret: "hide" });
    writeFileSync(png, picture);
    const problems: string[] = [];
    let changed = false;
    if (this.updating || !existsSync(baseline)) {
      writeFileSync(baseline, picture);
      problems.push(...(this.updating ? [] : [`${file}: no baseline yet (written: look at it and commit it)`]));
    } else {
      const { differ, total, diff } = comparePng(readFileSync(baseline), picture);
      if (differ > total * 0.002) {
        changed = true;
        if (diff !== undefined) {
          writeFileSync(join(this.options.report, `${file}.diff.png`), diff);
        } else {
          // another size: nothing to overlay
        }
        problems.push(`${file}: ${Number.isFinite(differ) ? `${differ} of ${total} pixels` : "its size"} differ from its baseline`);
      } else {
        // as reviewed
      }
    }
    problems.push(...this.unknown(file, await webRules(page)));
    this.shots.push({ name, client: "web", png, problems, changed });
  }

  /** Rules broken on this run's screens (accepted as known when the baselines are written). */
  private readonly broken: string[] = [];

  private unknown(file: string, found: string[]): string[] {
    const named = found.map((problem) => `${file}: ${problem}`);
    this.broken.push(...named);
    return this.updating ? [] : named.filter((problem) => !this.known.has(problem));
  }

  /** Every problem of the run: differences from the baselines and rules broken that are not known. */
  problems(): string[] {
    return this.shots.flatMap((shot) => shot.problems);
  }

  /** The sheet: every screen by name, the TUI's and the web's side by side; index.html and sheet.png. */
  async sheet(title: string): Promise<{ html: string; png: string }> {
    const names = [...new Set(this.shots.map((shot) => shot.name))];
    const cell = (shot: Shot | undefined): string =>
      shot === undefined ? "<td></td>" : `<td class="${shot.changed ? "changed" : ""}"><img src="${shot.png}" style="max-width:900px"><ul>${shot.problems.map((problem) => `<li>${problem.replace(/</g, "&lt;")}</li>`).join("")}</ul></td>`;
    const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
body{background:#111;color:#ddd;font:13px sans-serif}td{vertical-align:top;padding:8px}h2{font-size:14px}.changed{outline:3px solid #e33}li{color:#f88}</style>
<h1>${title}</h1><table>${names
      .map((name) => `<tr><th colspan="2"><h2>${name}</h2></th></tr><tr>${cell(this.shots.find((shot) => shot.name === name && shot.client === "tui"))}${cell(this.shots.find((shot) => shot.name === name && shot.client === "web"))}</tr>`)
      .join("")}</table>`;
    const htmlFile = join(this.options.report, "index.html");
    writeFileSync(htmlFile, html);
    if (this.updating) {
      // the baselines written are accepted with the rules they break: known issues, each waiting for its fix
      writeFileSync(join(this.options.baselines, "known-issues.json"), `${JSON.stringify([...new Set(this.broken)].sort(), null, 2)}\n`);
    } else {
      // the known issues stay as reviewed
    }
    const png = join(this.options.report, "sheet.png");
    const { chromium } = await import("playwright-core");
    const { bundledBrowser } = await import("./rasterize.ts");
    const browser = await chromium.launch({ executablePath: bundledBrowser(), args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
      await page.goto(`file://${htmlFile}`);
      await page.screenshot({ path: png, fullPage: true });
    } finally {
      await browser.close();
    }
    return { html: htmlFile, png };
  }
}
