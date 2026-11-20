/**
 * harness - the side panel: a full-height overlay on the right quarter of the
 * screen, opened and closed by Ctrl+\ (desktop profile, TUI only). It holds
 * sections of rows - toggles (madness, simple) and actions (/deps) - and is
 * built to take more sections later without changing this component.
 *
 * Keys are layout-independent: ↑/↓ move between rows (cyclic, section titles
 * are skipped), Space/Enter apply a row, Esc or Ctrl+\ close. A toggle keeps
 * the panel open; an action closes it first, so whatever it shows is not
 * hidden under the panel.
 */

import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export type PanelItem =
  | { kind: "toggle"; label: string; tone: "success" | "error"; on: () => boolean; toggle: () => void }
  | { kind: "action"; label: string; hint: string; run: () => void };

export type PanelSection = { title: string; items: PanelItem[] };

/** Closes the panel from outside (a dialog opening, the shortcut). */
export type PanelHandle = { close(): void };

/** The shortcut that opens the panel; it closes the panel too while the panel has the keyboard. */
export const PANEL_SHORTCUT = "ctrl+\\";

const PANEL_WIDTH = "25%";
const PANEL_MIN_WIDTH = 32;
/** Columns before a row's content: the border and the selection marker, then a space. */
const ROW_INDENT = 3;
const FOOTER = ["↑↓ select · space apply", "esc close"];

/**
 * Shows the panel with the keyboard. onClosed runs once the panel is gone,
 * however it closed.
 */
export function openPanel(ctx: ExtensionContext, sections: PanelSection[], onClosed: () => void): PanelHandle {
  let finish: (() => void) | undefined;
  let closeRequested = false;
  ctx.ui
    .custom<void>(
      (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: void) => void): Component => {
        let finished = false;
        finish = (): void => {
          if (finished) {
            // already closing: done() must run once
          } else {
            finished = true;
            done(undefined);
          }
        };
        if (closeRequested) {
          // closed before it was shown: close as soon as it is
          queueMicrotask(finish);
        } else {
          // shown normally
        }
        return new SidePanel(tui, theme, keybindings, sections, finish);
      },
      { overlay: true, overlayOptions: { anchor: "top-right", width: PANEL_WIDTH, minWidth: PANEL_MIN_WIDTH } },
    )
    .then(onClosed, (error: unknown) => {
      onClosed();
      ctx.ui.notify(`harness: panel failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  return {
    close(): void {
      if (finish !== undefined) {
        finish();
      } else {
        closeRequested = true;
      }
    },
  };
}

/** One rendered row: a section title, a selectable item, or empty space. */
type Row = { kind: "title"; text: string } | { kind: "item"; item: PanelItem } | { kind: "blank" };

class SidePanel implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly rows: Row[];
  private readonly selectable: number[];
  private readonly close: () => void;
  private selected = 0; // index into selectable
  private scroll = 0; // first body row shown

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, sections: PanelSection[], close: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.close = close;
    this.rows = sections.flatMap((section): Row[] => [
      { kind: "title", text: section.title.toUpperCase() },
      ...section.items.map((item): Row => ({ kind: "item", item })),
      { kind: "blank" },
    ]);
    this.selectable = this.rows.flatMap((row, index) => (row.kind === "item" ? [index] : []));
  }

  handleInput(data: string): void {
    const count = this.selectable.length;
    if (matchesKey(data, "escape") || matchesKey(data, PANEL_SHORTCUT)) {
      this.close();
    } else if (count === 0) {
      // nothing to move to or apply
    } else if (this.keybindings.matches(data, "tui.select.up")) {
      this.selected = (this.selected - 1 + count) % count;
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selected = (this.selected + 1) % count;
      this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
      this.apply(this.selectedItem());
    } else {
      // any other key does nothing here
    }
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows;
    const header = [this.line(this.theme.fg("accent", this.theme.bold("harness"))), this.line("")];
    const footer = [this.line(""), ...FOOTER.map((text) => this.line(this.theme.fg("dim", text)))];
    const bodyHeight = Math.max(0, height - header.length - footer.length);
    const body = this.visibleRows(bodyHeight).map((index) => this.renderRow(index));
    const filler = Array.from({ length: bodyHeight - body.length }, () => this.line(""));
    return [...header, ...body, ...filler, ...footer]
      .slice(0, height)
      .map((render) => render(width));
  }

  invalidate(): void {
    // rows are rendered from live state on every render: nothing cached
  }

  private selectedItem(): PanelItem {
    const row = this.rows[this.selectable[this.selected]];
    if (row?.kind === "item") {
      return row.item;
    } else {
      throw new Error(`panel: row ${this.selected} is not selectable`);
    }
  }

  private apply(item: PanelItem): void {
    switch (item.kind) {
      case "toggle":
        item.toggle();
        this.tui.requestRender();
        break;
      case "action":
        this.close();
        item.run();
        break;
      default:
        throw new Error(`unknown panel item: ${JSON.stringify(item satisfies never)}`);
    }
  }

  /** Indexes of the rows shown in a body of the given height, scrolled to keep the selection visible. */
  private visibleRows(bodyHeight: number): number[] {
    const target = this.selectable[this.selected] ?? 0;
    if (target < this.scroll) {
      this.scroll = target;
    } else if (target >= this.scroll + bodyHeight) {
      this.scroll = target - bodyHeight + 1;
    } else {
      // the selection is already visible
    }
    return this.rows.map((_row, index) => index).slice(this.scroll, this.scroll + bodyHeight);
  }

  private renderRow(index: number): (width: number) => string {
    const row = this.rows[index];
    switch (row?.kind) {
      case "title":
        return this.line(this.theme.fg("muted", row.text));
      case "blank":
        return this.line("");
      case "item":
        return this.itemLine(row.item, index === this.selectable[this.selected]);
      default:
        throw new Error(`panel: no row ${index}`);
    }
  }

  private itemLine(item: PanelItem, selected: boolean): (width: number) => string {
    return (width: number): string => {
      const contentWidth = Math.max(0, width - ROW_INDENT - 1);
      let value: string;
      switch (item.kind) {
        case "toggle":
          value = item.on() ? this.theme.fg(item.tone, "●━━  on") : this.theme.fg("dim", "━━○ off");
          break;
        case "action":
          value = this.theme.fg("dim", item.hint);
          break;
        default:
          throw new Error(`unknown panel item: ${JSON.stringify(item satisfies never)}`);
      }
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      const gap = contentWidth - visibleWidth(item.label) - visibleWidth(value);
      const content = gap >= 1 ? `${label}${" ".repeat(gap)}${value}` : truncateToWidth(label, contentWidth);
      return this.frame(content, width, selected);
    };
  }

  /** An unselected row with the given content. */
  private line(content: string): (width: number) => string {
    return (width: number): string => this.frame(content, width, false);
  }

  /** Border, selection marker and background around a row's content, exactly width columns. */
  private frame(content: string, width: number, selected: boolean): string {
    const border = this.theme.fg("borderAccent", "┃");
    const marker = selected ? this.theme.fg("accent", "▌") : " ";
    const inner = truncateToWidth(`${marker} ${content}`, Math.max(0, width - 1));
    const padded = inner + " ".repeat(Math.max(0, width - 1 - visibleWidth(inner)));
    return border + this.theme.bg(selected ? "selectedBg" : "customMessageBg", padded);
  }
}
