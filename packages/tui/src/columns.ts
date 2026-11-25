// The side columns of the workbench and the status rows: tabs of open sessions on the left, the
// items of the active session on the right — one glyph, then the name; the active row on the
// selection background; the mode in the name's color.
//
// Both strips answer the keyboard and the mouse alike. Focused (Alt+←/→ from the editor), ↑/↓ move
// a cursor, Enter opens its row, Esc returns to the editor (tabs: Delete closes one). A click opens
// a row, the middle button closes a tab, the pointer over a row lights it up.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  HStack,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type StackChild,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
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

/** What a strip does with its rows. */
export type StripActions = {
  open(index: number): void;
  /** The middle button or Delete on a row (tabs: closes the session's tab). */
  close?(index: number): void;
  /** Esc: the keyboard goes back to the editor. */
  leave(): void;
};

/**
 * A strip of rows under a title. `rows` are drawn by the subclass; this class keeps the keyboard
 * cursor, the hovered row and the mapping of screen lines to rows.
 */
abstract class Strip implements Component, Focusable {
  focused = false;
  protected readonly theme: () => Theme;
  private readonly actions: StripActions;
  /** The keyboard's row while focused. */
  protected cursor = 0;
  /** The row under the pointer. */
  protected hover: number | undefined;
  /** For each drawn line, the row it shows (undefined: a title or a header). */
  private lineRows: (number | undefined)[] = [];

  constructor(theme: () => Theme, actions: StripActions) {
    this.theme = theme;
    this.actions = actions;
  }

  protected abstract rowCount(): number;
  /** The row that is open now (the active tab, the selected item). */
  protected abstract activeRow(): number;
  /** Lines with the row each shows. */
  protected abstract lines(width: number): { line: string; row?: number }[];

  /** Focus from the editor: the cursor starts on the open row. */
  enter(): void {
    this.cursor = Math.max(0, Math.min(this.rowCount() - 1, this.activeRow()));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const drawn = this.lines(width);
    this.lineRows = drawn.map((entry) => entry.row);
    return drawn.map((entry) => entry.line);
  }

  /** A row's look: the keyboard's cursor or the open row on the selection background, the hovered one lit. */
  protected paint(row: number, text: string, width: number): string {
    const theme = this.theme();
    const line = pad(text, width);
    const marked = this.focused ? row === this.cursor : row === this.activeRow();
    return marked ? theme.bg("selectedBg", line) : row === this.hover ? theme.bg("userMessageBg", line) : line;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const count = this.rowCount();
    if (keys.matches(data, "tui.select.up")) {
      this.cursor = count === 0 ? 0 : (this.cursor - 1 + count) % count;
    } else if (keys.matches(data, "tui.select.down")) {
      this.cursor = count === 0 ? 0 : (this.cursor + 1) % count;
    } else if (keys.matches(data, "tui.select.confirm") || matchesKey(data, Key.space)) {
      if (count > 0) {
        this.actions.open(this.cursor);
      } else {
        // nothing to open
      }
    } else if (matchesKey(data, Key.delete) && this.actions.close !== undefined) {
      this.actions.close(this.cursor);
    } else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.tab)) {
      this.actions.leave();
    } else {
      // a key the strip does not use
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const row = this.lineRows[event.y];
    if (event.type === "move") {
      const changed = row !== this.hover;
      this.hover = row;
      return changed ? { handled: true, render: true } : { handled: true };
    } else if (event.type === "click" && row !== undefined && event.button === "left") {
      this.cursor = row;
      this.actions.open(row);
      return { handled: true, render: true };
    } else if (event.type === "click" && row !== undefined && event.button === "middle" && this.actions.close !== undefined) {
      this.actions.close(row);
      return { handled: true, render: true };
    } else if (event.type === "press" && row !== undefined) {
      return { handled: true }; // the click comes on release
    } else {
      return undefined;
    }
  }

  /** The pointer left the strip: nothing lit. True when something was. */
  clearHover(): boolean {
    const had = this.hover !== undefined;
    this.hover = undefined;
    return had;
  }
}

export class TabsColumn extends Strip {
  tabs: Tab[] = [];
  active = 0;

  protected rowCount(): number {
    return this.tabs.length + 1; // the tabs, then "+ new"
  }

  protected activeRow(): number {
    return this.active;
  }

  protected lines(width: number): { line: string; row?: number }[] {
    const theme = this.theme();
    const lines: { line: string; row?: number }[] = [{ line: pad(theme.fg("dim", " sessions"), width) }];
    let lastNode: string | undefined;
    const nodes = new Set(this.tabs.map((tab) => tab.node));
    this.tabs.forEach((tab, index) => {
      if (nodes.size > 1 && tab.node !== lastNode) {
        lines.push({ line: pad(theme.fg("dim", ` ${tab.node}`), width) });
        lastNode = tab.node;
      } else {
        // one node, or the same node as the tab above
      }
      const name = modeColor(tab.mode, theme.getColorMode(), tab.title);
      lines.push({ line: this.paint(index, `${glyphColor(theme, tab.glyph)} ${name}`, width), row: index });
    });
    const add = this.tabs.length;
    lines.push({ line: this.paint(add, `${theme.fg("dim", "+")} ${theme.fg("dim", "new")}`, width), row: add });
    return lines;
  }
}

export class ItemsColumn extends Strip {
  items: Item[] = [];
  selected = "session";
  mode: RunMode = "plan";

  protected rowCount(): number {
    return this.items.length;
  }

  protected activeRow(): number {
    return Math.max(0, this.items.findIndex((item) => item.id === this.selected));
  }

  /** The item a row shows. */
  itemAt(row: number): Item | undefined {
    return this.items[row];
  }

  protected lines(width: number): { line: string; row?: number }[] {
    const theme = this.theme();
    const lines: { line: string; row?: number }[] = [{ line: pad(theme.fg("dim", " session"), width) }];
    this.items.forEach((item, index) => {
      const indent = "  ".repeat(item.depth);
      const label = item.kind === "session" ? modeColor(this.mode, theme.getColorMode(), item.label) : item.label;
      const detail = item.detail !== "" ? ` ${theme.fg("dim", item.detail)}` : "";
      const labelWidth = Math.max(4, width - 2 - indent.length - visibleWidth(detail));
      lines.push({ line: this.paint(index, `${glyphColor(theme, item.glyph)} ${indent}${truncateToWidth(label, labelWidth)}${detail}`, width), row: index });
    });
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

/**
 * The screen's columns. Pointer moves reach it only where no component inside took them: there it
 * runs `onPointerElsewhere` (unlights the strips' rows; true when something changed).
 */
export class Workspace extends HStack {
  private readonly onPointerElsewhere: () => boolean;

  constructor(children: StackChild[], onPointerElsewhere: () => boolean) {
    super(children);
    this.onPointerElsewhere = onPointerElsewhere;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<HStack["handleMouse"]> {
    if (event.type === "move" && this.onPointerElsewhere()) {
      const target = { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height };
      return { handled: true, render: true, target };
    } else {
      return undefined; // nothing to do here: other boxes under the pointer may take it
    }
  }
}

/** A vertical rule between the strips and the main area, as tall as the screen. */
export class VRule implements Component {
  private readonly theme: () => Theme;
  private readonly height: () => number;

  constructor(theme: () => Theme, height: () => number) {
    this.theme = theme;
    this.height = height;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const line = this.theme().fg("borderMuted", "│");
    return Array.from({ length: Math.max(1, this.height()) }, () => line);
  }
}
