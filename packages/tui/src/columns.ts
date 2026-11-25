// The strip on the left of the workbench, in three blocks under one another, divided by rules and
// with no titles: the nodes (as tall as their rows, `+ add` last), the chosen node's sessions (two
// thirds of the rest, `+ new` last) and the active session's items (a third: `session` first, then
// its tasks and subagents). One glyph, then the name; the active row on the selection background;
// a session's mode in its name's color.
//
// The keyboard and the mouse alike: focused (Alt+← from the editor), one cursor walks all three
// blocks with ↑/↓, Enter opens its row, Delete closes a session's tab, Esc returns to the editor. A
// click opens a row, the middle button closes a tab, the pointer over a row lights it up.

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
import type { Item, NodeRow, Tab } from "#client/workbench/workbench.ts";
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

/** A row of the strip: what it opens. */
export type StripRow =
  | { kind: "node"; node: NodeRow }
  | { kind: "add" }
  | { kind: "tab"; tab: Tab }
  | { kind: "new" }
  | { kind: "item"; item: Item };

/** What the strip does with its rows. */
export type StripActions = {
  open(row: StripRow): void;
  /** The middle button or Delete on a session's row: its tab closes. */
  close(tab: Tab): void;
  /** Esc: the keyboard goes back to the editor. */
  leave(): void;
};

/** What the strip shows, from the workbench's screen. */
export type StripContent = {
  nodes: NodeRow[];
  node: string | undefined;
  tabs: Tab[];
  /** The active tab among `tabs` (-1: none, a new session is being placed). */
  active: number;
  newSession: boolean;
  items: Item[];
  selected: string;
  mode: RunMode;
};

const EMPTY: StripContent = { nodes: [], node: undefined, tabs: [], active: -1, newSession: false, items: [], selected: "session", mode: "plan" };

/** A row's identity, kept across refreshes (the cursor stays on it). */
function rowKey(row: StripRow): string {
  switch (row.kind) {
    case "node":
      return `node:${row.node.name}`;
    case "add":
      return "add";
    case "tab":
      return `tab:${row.tab.node}/${row.tab.sessionId}`;
    case "new":
      return "new";
    case "item":
      return `item:${row.item.id}`;
    default:
      throw new Error(`unknown strip row: ${JSON.stringify(row satisfies never)}`);
  }
}

export class SideStrip implements Component, Focusable {
  focused = false;
  content: StripContent = EMPTY;
  private readonly theme: () => Theme;
  private readonly height: () => number;
  private readonly actions: StripActions;
  /** The keyboard's row while focused (its key). */
  private cursor: string | undefined;
  /** The row under the pointer (its key). */
  private hover: string | undefined;
  /** For each drawn line, the row it shows (undefined: a rule, an empty line). */
  private lineRows: (StripRow | undefined)[] = [];

  constructor(theme: () => Theme, height: () => number, actions: StripActions) {
    this.theme = theme;
    this.height = height;
    this.actions = actions;
  }

  /** The three blocks' rows. */
  blocks(): { nodes: StripRow[]; sessions: StripRow[]; items: StripRow[] } {
    const content = this.content;
    return {
      nodes: [...content.nodes.map((node): StripRow => ({ kind: "node", node })), { kind: "add" }],
      sessions: [...content.tabs.map((tab): StripRow => ({ kind: "tab", tab })), { kind: "new" }],
      items: content.newSession ? [] : content.items.map((item): StripRow => ({ kind: "item", item })),
    };
  }

  private rows(): StripRow[] {
    const blocks = this.blocks();
    return [...blocks.nodes, ...blocks.sessions, ...blocks.items];
  }

  /** The row that is open now: the active session's selected item, else its tab. */
  private openKey(): string {
    const content = this.content;
    const tab = content.tabs[content.active];
    if (content.newSession) {
      return "new";
    } else if (tab !== undefined) {
      return `tab:${tab.node}/${tab.sessionId}`;
    } else {
      return content.node !== undefined ? `node:${content.node}` : "add";
    }
  }

  /** Whether a row is open now: the chosen node, the active tab, the selected item. */
  private isOpen(row: StripRow): boolean {
    const content = this.content;
    switch (row.kind) {
      case "node":
        return row.node.name === content.node;
      case "tab":
        return !content.newSession && content.tabs[content.active] === row.tab;
      case "new":
        return content.newSession;
      case "item":
        return row.item.id === content.selected;
      case "add":
        return false;
      default:
        throw new Error(`unknown strip row: ${JSON.stringify(row satisfies never)}`);
    }
  }

  /** Focus from the editor: the cursor starts on the active session. */
  enter(): void {
    this.cursor = this.openKey();
  }

  invalidate(): void {}

  private drawRow(row: StripRow, width: number): string {
    const theme = this.theme();
    let text: string;
    switch (row.kind) {
      case "node":
        text = `${row.node.glyph !== "" ? glyphColor(theme, row.node.glyph) : " "} ${row.node.label}`;
        break;
      case "add":
        text = theme.fg("dim", "+ add");
        break;
      case "tab":
        text = `${glyphColor(theme, row.tab.glyph)} ${modeColor(row.tab.mode, theme.getColorMode(), row.tab.title)}`;
        break;
      case "new":
        text = this.content.newSession ? `${theme.fg("accent", "›")} new session` : theme.fg("dim", "+ new");
        break;
      case "item": {
        const item = row.item;
        const indent = "  ".repeat(item.depth);
        const label = item.kind === "session" ? modeColor(this.content.mode, theme.getColorMode(), "session") : item.label;
        const detail = item.kind !== "session" && item.detail !== "" ? ` ${theme.fg("dim", item.detail)}` : "";
        const labelWidth = Math.max(4, width - 2 - indent.length - visibleWidth(detail));
        text = `${glyphColor(theme, item.glyph)} ${indent}${truncateToWidth(label, labelWidth)}${detail}`;
        break;
      }
      default:
        throw new Error(`unknown strip row: ${JSON.stringify(row satisfies never)}`);
    }
    const line = pad(text, width);
    const key = rowKey(row);
    const marked = this.focused ? key === this.cursor : this.isOpen(row);
    return marked ? theme.bg("selectedBg", line) : key === this.hover ? theme.bg("userMessageBg", line) : line;
  }

  /** `count` lines of a block: its rows from where the marked one is in sight, then empty lines. */
  private window(rows: StripRow[], count: number): (StripRow | undefined)[] {
    const marked = rows.findIndex((row) => (this.focused ? rowKey(row) === this.cursor : this.isOpen(row)));
    const start = rows.length <= count ? 0 : Math.max(0, Math.min(rows.length - count, marked - Math.floor(count / 2)));
    const shown: (StripRow | undefined)[] = rows.slice(start, start + count);
    return [...shown, ...Array.from({ length: Math.max(0, count - shown.length) }, () => undefined)];
  }

  render(width: number): string[] {
    const theme = this.theme();
    const blocks = this.blocks();
    const height = Math.max(6, this.height());
    const nodes = Math.min(blocks.nodes.length, Math.max(1, height - 6));
    const rest = Math.max(2, height - nodes - 2);
    const sessions = Math.ceil((rest * 2) / 3);
    const items = rest - sessions;
    const rule: StripRow | undefined = undefined;
    this.lineRows = [...this.window(blocks.nodes, nodes), rule, ...this.window(blocks.sessions, sessions), rule, ...this.window(blocks.items, items)];
    const ruleAt = new Set([nodes, nodes + 1 + sessions]);
    return this.lineRows.map((row, index) => (ruleAt.has(index) ? theme.fg("borderMuted", "─".repeat(width)) : row !== undefined ? this.drawRow(row, width) : " ".repeat(width)));
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const rows = this.rows();
    const at = Math.max(0, rows.findIndex((row) => rowKey(row) === this.cursor));
    const current = rows[at];
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      const next = rows[(at + (keys.matches(data, "tui.select.up") ? rows.length - 1 : 1)) % Math.max(1, rows.length)];
      this.cursor = next !== undefined ? rowKey(next) : undefined;
    } else if (keys.matches(data, "tui.select.confirm") || matchesKey(data, Key.space)) {
      if (current !== undefined) {
        this.actions.open(current);
      } else {
        // nothing to open
      }
    } else if (matchesKey(data, Key.delete) && current?.kind === "tab") {
      this.actions.close(current.tab);
    } else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.tab)) {
      this.actions.leave();
    } else {
      // a key the strip does not use
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const row = this.lineRows[event.y];
    if (event.type === "move") {
      const key = row !== undefined ? rowKey(row) : undefined;
      const changed = key !== this.hover;
      this.hover = key;
      return changed ? { handled: true, render: true } : { handled: true };
    } else if (event.type === "click" && row !== undefined && event.button === "left") {
      this.cursor = rowKey(row);
      this.actions.open(row);
      return { handled: true, render: true };
    } else if (event.type === "click" && row?.kind === "tab" && event.button === "middle") {
      this.actions.close(row.tab);
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
