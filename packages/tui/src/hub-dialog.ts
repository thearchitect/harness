// The /hub dialog in the editor's place (client/workbench/hub-dialog.ts draws the same everywhere):
// no padding, so the pairing link selects without spaces around it (it is a terminal hyperlink as
// well); the QR code in half blocks, quiet zone included. Keys: ↑/↓ move, Enter applies, typing goes
// into a field row (LineField), ← outside a field (or in an empty one) goes back a screen, Esc closes. The mouse: a click
// applies a row, the pointer lights it.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, hyperlink, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { HubDialog, HubDialogRow } from "#client/workbench/hub-dialog.ts";
import { LineField } from "#extension/presentation/tui/line-field.ts";

/** A QR code as lines of half blocks: two module rows per line, a quiet zone of two modules around. */
export function qrLines(qr: { size: number; modules: string }): string[] {
  const quiet = 2;
  const size = qr.size + quiet * 2;
  const dark = (x: number, y: number): boolean => {
    const inner = { x: x - quiet, y: y - quiet };
    return inner.x >= 0 && inner.y >= 0 && inner.x < qr.size && inner.y < qr.size && qr.modules[inner.y * qr.size + inner.x] === "1";
  };
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x += 1) {
      // light modules are drawn (a dark terminal's background is dark): top and bottom halves
      const top = !dark(x, y);
      const bottom = y + 1 < size ? !dark(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines;
}

export class HubDialogView implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: () => Theme;
  private readonly dialog: HubDialog;
  private readonly field: LineField;
  /** The field row the LineField shows now (its value is set when it becomes the selected one). */
  private fieldRow: string | undefined;
  private focusedState = false;
  /** For each drawn line, the row it shows. */
  private lineRows: (number | undefined)[] = [];

  constructor(tui: TUI, theme: () => Theme, dialog: HubDialog) {
    this.tui = tui;
    this.theme = theme;
    this.dialog = dialog;
    this.field = new LineField({ prompt: "" });
    this.field.onChange = (value) => this.dialog.type(value);
    this.field.onSubmit = () => void this.dialog.enter();
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
  }

  private selectedRow(): HubDialogRow | undefined {
    return this.dialog.rows()[this.dialog.selected];
  }

  /** The LineField follows the selected row: a field's text when one is selected. */
  private syncField(): void {
    const row = this.selectedRow();
    const key = row?.kind === "field" ? `${this.dialog.screen.kind}:${row.id}:${row.value}` : undefined;
    if (key !== this.fieldRow) {
      this.fieldRow = key;
      this.field.value = row?.kind === "field" ? this.dialog.fieldText(row) : "";
    } else {
      // the same field: what is typed stays
    }
    this.field.focused = this.focusedState && row?.kind === "field" && !row.locked;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const row = this.selectedRow();
    const inField = row?.kind === "field" && !row.locked;
    if (keys.matches(data, "tui.select.cancel")) {
      this.dialog.close();
    } else if (keys.matches(data, "tui.select.up")) {
      this.dialog.move(-1);
    } else if (keys.matches(data, "tui.select.down")) {
      this.dialog.move(1);
    } else if (inField && matchesKey(data, "left") && this.field.value === "") {
      this.dialog.back(); // an empty field has nowhere to move: ← goes back
    } else if (inField) {
      this.syncField();
      this.field.handleInput(data); // typing, the cursor's moves, deleting, paste; Enter applies
    } else if (matchesKey(data, "left")) {
      this.dialog.back();
    } else if (keys.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
      void this.dialog.enter();
    } else {
      // a key this dialog does not use
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const index = this.lineRows[event.y];
    if (index === undefined) {
      return undefined;
    } else if (event.type === "move") {
      const changed = index !== this.dialog.selected;
      this.dialog.selected = index;
      return { handled: true, render: changed };
    } else if (event.type === "click" && event.button === "left") {
      this.dialog.selected = index;
      void this.dialog.enter();
      return { handled: true, render: true };
    } else {
      return { handled: true };
    }
  }

  invalidate(): void {
    this.field.invalidate();
  }

  render(width: number): string[] {
    const theme = this.theme();
    const dialog = this.dialog;
    const lines: { line: string; row?: number }[] = [];
    const add = (line: string, row?: number): void => {
      lines.push(row !== undefined ? { line, row } : { line });
    };
    this.syncField();

    add(theme.fg("borderAccent", "─".repeat(width)));
    add(theme.fg("accent", theme.bold(truncateToWidth(dialog.title(), width))));
    const screen = dialog.screen;
    if (screen.kind === "pairing") {
      const { pairing } = screen;
      const state = dialog.pairingState();
      if (state?.kind === "open") {
        for (const line of pairing.qr !== undefined ? qrLines(pairing.qr) : []) {
          add(truncateToWidth(line, width));
        }
        if (pairing.link !== undefined) {
          // the link whole, cut at the width without padding: every piece links to all of it
          const chars = [...pairing.link];
          for (let start = 0; start < chars.length; start += width) {
            add(hyperlink(theme.fg("accent", chars.slice(start, start + width).join("")), pairing.link));
          }
        } else {
          add(theme.fg("warning", "no link: the hub has no address for links yet (main screen, address for links)"));
        }
        add(theme.fg("text", `code ${pairing.code}`));
        add(theme.fg("muted", `valid until ${state.until}, once`));
      } else if (state?.kind === "used") {
        add(theme.fg("success", `used: ${state.device}`));
      } else {
        add(theme.fg("warning", "expired: make a new code"));
      }
    } else if (dialog.status === undefined) {
      add(theme.fg("muted", dialog.error !== undefined ? "" : "reading the hub…"));
    } else {
      // the rows say it all
    }

    const rows = dialog.rows();
    const firstDevice = rows.findIndex((row) => row.kind === "device");
    rows.forEach((row, index) => {
      const selected = index === dialog.selected;
      if (index === firstDevice) {
        add(theme.fg("muted", "devices"));
      } else {
        // not the first device row
      }
      if (row.kind === "field" && selected && !row.locked) {
        const label = `${row.label}: `;
        add(`${theme.fg("accent", "▌")}${theme.fg("muted", label)}${this.field.render(Math.max(1, width - 1 - visibleWidth(label)))[0] ?? ""}`, index);
      } else {
        const marker = selected ? theme.fg("accent", "▌") : " ";
        const text =
          row.kind === "field"
            ? `${theme.fg("muted", `${row.label}: `)}${row.value !== "" ? row.value : theme.fg("dim", "—")}`
            : row.kind === "toggle"
              ? `${row.label}: ${row.on ? theme.fg("success", "on") : "off"}`
              : row.kind === "network"
                ? row.label
                : row.kind === "device"
                  ? `${row.connected ? theme.fg("success", "● ") : "  "}${row.name} ${theme.fg("muted", row.detail)}`
                  : row.label;
        const line = truncateToWidth(`${marker}${text}`, width);
        add(selected ? theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))) : line, index);
      }
    });
    if (dialog.error !== undefined) {
      add(theme.fg("error", truncateToWidth(dialog.error, width)));
    } else {
      // nothing failed
    }
    add(theme.fg("dim", truncateToWidth(dialog.hint(), width)));
    add(theme.fg("borderAccent", "─".repeat(width)));
    this.lineRows = lines.map((entry) => entry.row);
    return lines.map((entry) => entry.line);
  }
}
