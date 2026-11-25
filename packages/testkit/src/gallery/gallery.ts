// The TUI gallery: every fixture drawn by the TUI's own components on a virtual terminal, captured
// as text, ANSI and PNG into `.test-reports/<run>/gallery/` with an index.html. A tool for looking,
// not a test: it fails only when a fixture cannot be drawn (an exception, an empty screen).
// `--compare <dir>` lists, per fixture, the earlier capture next to the new one for review.

import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, TuiAltScreen, type Component, type TUI } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GateDialog } from "#extension/presentation/tui/gate.ts";
import { QuestionsDialog } from "#extension/presentation/tui/questions.ts";
import { SecretDialog } from "#extension/presentation/tui/secret.ts";
import { choiceDialog, piDialog } from "#extension/presentation/tui/dialogs.ts";
import type { InteractionRequest } from "#protocol/interactions.ts";
import { ItemsColumn, TabsColumn } from "#tui/columns.ts";
import { getTheme } from "#tui/theme.ts";
import { gridHtml, screenshot } from "../capture/rasterize.ts";
import { VirtualTerminal } from "../drivers/terminal.ts";
import { INTERACTIONS, ITEMS, TABS } from "../fixtures/fixtures.ts";
import { reportsRoot } from "../report/report.ts";

type Exhibit = { name: string; width: number; component(tui: TUI): Component };

function interaction(tui: TUI, request: InteractionRequest): Component {
  const theme = getTheme();
  const answer = (): void => undefined;
  switch (request.kind) {
    case "gate":
      return new GateDialog(tui, theme, request.payload, answer);
    case "secret":
      return new SecretDialog(tui, theme, request.payload, answer);
    case "questions":
      return new QuestionsDialog(tui, theme, request.payload, answer);
    case "choice":
      return choiceDialog(theme, request.payload, answer);
    case "pi-dialog":
      return piDialog(tui, theme, request.payload, answer);
    case "display":
      throw new Error("display has no dialog in the TUI");
    default:
      throw new Error(`unknown interaction: ${JSON.stringify(request satisfies never)}`);
  }
}

export function exhibits(): Exhibit[] {
  const theme = () => getTheme();
  return [
    ...Object.entries(INTERACTIONS).map(([name, request]) => ({ name: `interaction-${name}`, width: 100, component: (tui: TUI) => interaction(tui, request) })),
    {
      name: "tabs-all-glyphs",
      width: 26,
      component: () => {
        const column = new TabsColumn(theme);
        column.tabs = TABS;
        column.active = 1;
        return column;
      },
    },
    {
      name: "tabs-empty",
      width: 26,
      component: () => new TabsColumn(theme),
    },
    {
      name: "items-tasks-subagents",
      width: 30,
      component: () => {
        const column = new ItemsColumn(theme);
        column.items = ITEMS;
        column.selected = "t2";
        column.mode = "build";
        return column;
      },
    },
  ];
}

/** Draws one exhibit: its lines on a terminal as wide as the exhibit and as tall as its lines. */
async function draw(exhibit: Exhibit): Promise<VirtualTerminal> {
  const probe = new VirtualTerminal(exhibit.width, 1);
  const tui = new TuiAltScreen(probe); // never started: the dialogs only need its render requests
  const frame = new Container();
  frame.addChild(exhibit.component(tui));
  // pi-tui's cursor markers (APC "pi:…") are for the TUI to place cursors, never written to a terminal
  const lines = frame.render(exhibit.width).map((line) => line.split(CURSOR_MARKER).join("").replace(/\x1b_pi:[^\x07]*\x07/g, ""));
  if (lines.length === 0 || lines.every((line) => line.trim() === "")) {
    throw new Error(`${exhibit.name}: draws nothing`);
  } else {
    const terminal = new VirtualTerminal(exhibit.width, lines.length);
    terminal.write(lines.join("\r\n"));
    await terminal.flushed();
    return terminal;
  }
}

export type GalleryResult = { dir: string; index: string; exhibits: string[]; changed?: string[] };

export async function runGallery(options: { filter?: string; compare?: string; dir?: string } = {}): Promise<GalleryResult> {
  initTheme("dark", false);
  const run = process.env.HARNESS_TEST_RUN ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dir = options.dir ?? join(reportsRoot(), run, "gallery");
  mkdirSync(dir, { recursive: true });
  const chosen = exhibits().filter((exhibit) => options.filter === undefined || exhibit.name.includes(options.filter));
  const rows: string[] = [];
  const changed: string[] = [];
  for (const exhibit of chosen) {
    const terminal = await draw(exhibit);
    const text = `${terminal.text().join("\n")}\n`;
    writeFileSync(join(dir, `${exhibit.name}.txt`), text);
    writeFileSync(join(dir, `${exhibit.name}.ansi`), terminal.ansi);
    const png = await screenshot(gridHtml(terminal.cells())).catch(() => undefined);
    if (png !== undefined) {
      writeFileSync(join(dir, `${exhibit.name}.png`), png);
    } else {
      // no browser: text and ANSI only
    }
    const before = options.compare !== undefined ? join(options.compare, `${exhibit.name}.txt`) : undefined;
    const differs = before !== undefined && (!existsSync(before) || readFileSync(before, "utf8") !== text);
    if (differs) {
      changed.push(exhibit.name);
    } else {
      // unchanged, or nothing to compare with
    }
    const image = png !== undefined ? `<img src="${exhibit.name}.png">` : `<pre>${text.replace(/</g, "&lt;")}</pre>`;
    const was = differs && options.compare !== undefined && existsSync(join(options.compare, `${exhibit.name}.png`)) ? `<img src="${relative(dir, join(options.compare, `${exhibit.name}.png`))}">` : "";
    rows.push(`<tr><th>${exhibit.name}${differs ? " (changed)" : ""}</th><td>${was}</td><td>${image}</td></tr>`);
  }
  const index = join(dir, "index.html");
  writeFileSync(index, `<!doctype html><meta charset="utf-8"><title>harness gallery</title><style>body{background:#111;color:#ccc;font-family:monospace}td,th{vertical-align:top;padding:8px;text-align:left}</style><table><tr><th>fixture</th><th>before</th><th>TUI</th></tr>${rows.join("")}</table>`);
  return { dir, index, exhibits: chosen.map((exhibit) => exhibit.name), ...(options.compare !== undefined ? { changed } : {}) };
}
