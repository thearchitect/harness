// The harness panel (Ctrl+\): a full-height overlay on the right quarter of the screen, as harness
// drew it before the platform (panel.ts of 6681cf3) — sections of rows, toggles as `●━━  on` /
// `━━○ off`, actions with a hint on the right, the border `┃`, the selected row marked `▌` on the
// selection background, the keys at the bottom. Its rows are the workbench's (Workbench.panel), the
// same in every UI.
//
// Keys: ↑/↓ move (cyclic, titles skipped), Space/Enter apply, Esc or Ctrl+\ close. The mouse: a click
// applies a row, the pointer over a row selects it. A toggle keeps the panel open; an action closes it.
// A text field (the session's name) takes typing and Backspace as soon as it is selected; leaving it
// (↑/↓, closing) applies what was typed.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { PanelId, PanelItem, PanelSection } from "#client/workbench/workbench.ts";

/** The overlay's size: a quarter of the screen, never narrower than its rows need. */
export const PANEL_WIDTH = "25%";
export const PANEL_MIN_WIDTH = 32;

/** Columns before a row's content: the border and the selection marker, then a space. */
const ROW_INDENT = 3;
const FOOTER = ["↑↓ select · space apply", "esc close"];

/** One drawn row: a section title, a selectable item, or empty space. */
type Row = { kind: "title"; text: string } | { kind: "item"; item: PanelItem } | { kind: "blank" };

export type PanelOptions = {
  tui: TUI;
  theme: () => Theme;
  sections: () => PanelSection[];
  apply: (id: PanelId) => void;
  /** A text field's new value (typed). */
  edit: (id: PanelId, text: string) => void;
  /** The selection leaves a text field. */
  leave: (id: PanelId) => void;
  close: () => void;
  /** The keys that close it besides Esc (the panel's own shortcut). */
  closeKeys: readonly string[];
};

export class HarnessPanel implements Component, Focusable {
  focused = false;
  private readonly options: PanelOptions;
  /** The selected row, by id: rows come again from the workbench at every draw. */
  private selectedId: PanelId | undefined;
  private scroll = 0;
  /** For each drawn line, the item it shows. */
  private lineItems: (PanelItem | undefined)[] = [];

  constructor(options: PanelOptions) {
    this.options = options;
  }

  private rows(): Row[] {
    return this.options.sections().flatMap((section): Row[] => [
      { kind: "title", text: section.title.toUpperCase() },
      ...section.items.map((item): Row => ({ kind: "item", item })),
      { kind: "blank" },
    ]);
  }

  private items(rows: Row[]): PanelItem[] {
    return rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
  }

  private selectedIndex(items: PanelItem[]): number {
    return Math.max(0, items.findIndex((item) => item.id === this.selectedId));
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const items = this.items(this.rows());
    const count = items.length;
    const index = this.selectedIndex(items);
    const current = items[index];
    if (matchesKey(data, "escape") || this.options.closeKeys.some((key) => matchesKey(data, key as never))) {
      this.options.close();
    } else if (count === 0) {
      // nothing to move to or apply
    } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      if (current?.kind === "text") {
        this.options.leave(current.id);
      } else {
        // not a field
      }
      this.selectedId = items[(index + (keys.matches(data, "tui.select.up") ? count - 1 : 1)) % count]?.id;
      this.options.tui.requestRender();
    } else if (current?.kind === "text") {
      if (keys.matches(data, "tui.editor.deleteCharBackward")) {
        this.options.edit(current.id, [...current.value].slice(0, -1).join(""));
      } else if (visibleWidth(data) > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
        this.options.edit(current.id, `${current.value}${data}`);
      } else {
        // other keys do nothing in a field
      }
    } else if (keys.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
      const item = items[index];
      if (item !== undefined) {
        this.options.apply(item.id);
      } else {
        // no row
      }
    } else {
      // any other key does nothing here
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const item = this.lineItems[event.y];
    if (item === undefined) {
      return { handled: true }; // the panel's own space: nothing under it takes the pointer
    } else if (event.type === "move") {
      const changed = item.id !== this.selectedId;
      this.leaveField(item);
      this.selectedId = item.id;
      return { handled: true, render: changed };
    } else if (event.type === "click" && event.button === "left") {
      this.leaveField(item);
      this.selectedId = item.id;
      this.options.apply(item.id);
      return { handled: true, render: true };
    } else {
      return { handled: true };
    }
  }

  /** The pointer moves the selection off a text field: what was typed applies. */
  private leaveField(next: PanelItem): void {
    const items = this.items(this.rows());
    const current = items[this.selectedIndex(items)];
    if (current?.kind === "text" && current.id !== next.id) {
      this.options.leave(current.id);
    } else {
      // not leaving a field
    }
  }

  render(width: number): string[] {
    const theme = this.options.theme();
    const height = this.options.tui.terminal.rows;
    const rows = this.rows();
    const items = this.items(rows);
    const selected = items[this.selectedIndex(items)];
    this.selectedId = selected?.id;

    const header = [this.frame(theme.fg("accent", theme.bold("harness")), width, false), this.frame("", width, false)];
    const footer = [this.frame("", width, false), ...FOOTER.map((text) => this.frame(theme.fg("dim", text), width, false))];
    const bodyHeight = Math.max(0, height - header.length - footer.length);

    // scrolled to keep the selection visible
    const target = Math.max(0, rows.findIndex((row) => row.kind === "item" && row.item === selected));
    if (target < this.scroll) {
      this.scroll = target;
    } else if (target >= this.scroll + bodyHeight) {
      this.scroll = target - bodyHeight + 1;
    } else {
      // the selection is visible
    }
    const shown = rows.slice(this.scroll, this.scroll + bodyHeight);
    const body = shown.map((row) => this.row(row, row.kind === "item" && row.item === selected, width));
    const filler = Array.from({ length: bodyHeight - body.length }, () => this.frame("", width, false));

    this.lineItems = [...header.map(() => undefined), ...shown.map((row) => (row.kind === "item" ? row.item : undefined)), ...filler.map(() => undefined), ...footer.map(() => undefined)];
    return [...header, ...body, ...filler, ...footer].slice(0, height);
  }

  invalidate(): void {
    // rows come from live state at every draw: nothing cached
  }

  private row(row: Row, selected: boolean, width: number): string {
    const theme = this.options.theme();
    switch (row.kind) {
      case "title":
        return this.frame(theme.fg("muted", row.text), width, false);
      case "blank":
        return this.frame("", width, false);
      case "item":
        return this.itemLine(row.item, selected, width);
      default:
        throw new Error(`unknown panel row: ${JSON.stringify(row satisfies never)}`);
    }
  }

  private itemLine(item: PanelItem, selected: boolean, width: number): string {
    const theme = this.options.theme();
    const contentWidth = Math.max(0, width - ROW_INDENT - 1);
    let value: string;
    switch (item.kind) {
      case "toggle":
        value = item.on ? theme.fg(item.tone, "●━━  on") : theme.fg("dim", "━━○ off");
        break;
      case "value":
        value = theme.fg("muted", item.value);
        break;
      case "text": {
        // the field: what is typed, a cursor while selected; the session's title when empty
        const room = Math.max(4, contentWidth - visibleWidth(item.label) - 2);
        const cursor = selected ? theme.fg("accent", "▏") : "";
        if (item.value === "") {
          value = `${truncateToWidth(theme.fg("dim", item.placeholder), room - 1)}${cursor}`;
        } else {
          // the end of a long name stays in sight while it is typed
          const chars = [...item.value];
          let start = 0;
          while (start < chars.length && visibleWidth(chars.slice(start).join("")) > room - 1) {
            start += 1;
          }
          value = `${chars.slice(start).join("")}${cursor}`;
        }
        break;
      }
      case "action":
        value = theme.fg("dim", item.hint);
        break;
      default:
        throw new Error(`unknown panel item: ${JSON.stringify(item satisfies never)}`);
    }
    const label = selected ? theme.fg("accent", item.label) : item.label;
    const gap = contentWidth - visibleWidth(item.label) - visibleWidth(value);
    const content = gap >= 1 ? `${label}${" ".repeat(gap)}${value}` : truncateToWidth(label, contentWidth);
    return this.frame(content, width, selected);
  }

  /**
   * Border and selection marker around a row's content, exactly `width` columns. No background of
   * its own (the terminal's shows through, as under the chat); only the selected row is lit.
   */
  private frame(content: string, width: number, selected: boolean): string {
    const theme = this.options.theme();
    const border = theme.fg("borderAccent", "┃");
    const marker = selected ? theme.fg("accent", "▌") : " ";
    const inner = truncateToWidth(`${marker} ${content}`, Math.max(0, width - 1));
    const padded = inner + " ".repeat(Math.max(0, width - 1 - visibleWidth(inner)));
    return border + (selected ? theme.bg("selectedBg", padded) : padded);
  }
}
