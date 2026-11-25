// The side columns of the workbench and the status rows: tabs of open sessions on the left, the
// items of the active session on the right — one glyph, then the name; the selected row on the
// selection background; the mode in the name's color.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Item, Tab } from "#client/workbench/workbench.ts";
import type { RunMode } from "#protocol/state.ts";
import { modeColor } from "#extension/presentation/modes.ts";

function pad(line: string, width: number): string {
  const used = visibleWidth(line);
  return used >= width ? truncateToWidth(line, width) : line + " ".repeat(width - used);
}

function glyphColor(theme: Theme, glyph: string): string {
  switch (glyph) {
    case "◆":
      return theme.fg("warning", glyph);
    case "✗":
      return theme.fg("error", glyph);
    case "●":
      return theme.fg("accent", glyph);
    case "✓":
      return theme.fg("success", glyph);
    case "⊘":
      return theme.fg("dim", glyph);
    default:
      return glyph;
  }
}

export class TabsColumn implements Component {
  tabs: Tab[] = [];
  active = 0;
  private readonly theme: () => Theme;

  constructor(theme: () => Theme) {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme();
    const lines: string[] = [pad(theme.fg("dim", " sessions"), width)];
    let lastNode: string | undefined;
    const nodes = new Set(this.tabs.map((tab) => tab.node));
    this.tabs.forEach((tab, index) => {
      if (nodes.size > 1 && tab.node !== lastNode) {
        lines.push(pad(theme.fg("dim", ` ${tab.node}`), width));
        lastNode = tab.node;
      } else {
        // one node, or the same node as the tab above
      }
      const name = modeColor(tab.mode, theme.getColorMode(), tab.title);
      const row = pad(`${glyphColor(theme, tab.glyph)} ${name}`, width);
      lines.push(index === this.active ? theme.bg("selectedBg", row) : row);
    });
    lines.push(pad(theme.fg("dim", "+ new  ^T"), width));
    return lines;
  }
}

export class ItemsColumn implements Component {
  items: Item[] = [];
  selected = "session";
  mode: RunMode = "plan";
  private readonly theme: () => Theme;

  constructor(theme: () => Theme) {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme();
    const lines: string[] = [pad(theme.fg("dim", " session"), width)];
    for (const item of this.items) {
      const indent = "  ".repeat(item.depth);
      const label = item.kind === "session" ? modeColor(this.mode, theme.getColorMode(), item.label) : item.label;
      const detail = item.detail !== "" ? ` ${theme.fg("dim", item.detail)}` : "";
      const labelWidth = Math.max(4, width - 2 - indent.length - visibleWidth(detail));
      const row = pad(`${glyphColor(theme, item.glyph)} ${indent}${truncateToWidth(label, labelWidth)}${detail}`, width);
      lines.push(item.id === this.selected ? theme.bg("selectedBg", row) : row);
    }
    return lines;
  }
}

/** Lines set from outside: the status line, notices, the queue, widgets. */
export class Lines implements Component {
  lines: string[] = [];

  invalidate(): void {}

  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(line, width));
  }
}
