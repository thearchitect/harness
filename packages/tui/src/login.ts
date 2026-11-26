// A provider's login step in the editor's place (plan polish-3 C): no padding, so the sign-in link
// selects without spaces around it; the link is a terminal hyperlink (Ctrl+click opens it whole).
// Below the step's text, its rows (client/workbench/login.ts): open in browser, copy, the options
// of a choice, the field (LineField). Keys: ↑/↓ move and leave the field, Enter applies, typing and
// pasting go to the field at once, ← outside the field goes back one step, Esc cancels. The mouse:
// a click applies a row, the pointer lights it.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, hyperlink, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { loginHints, loginInitialRow, loginRows, type LoginRow } from "#client/workbench/login.ts";
import { LineField } from "#extension/presentation/tui/line-field.ts";
import type { LoginAnswer, LoginPayload } from "#protocol/interactions.ts";
import { hintLine } from "./picker.ts";

export type LoginActions = {
  open(url: string): void;
  copy(text: string): Promise<void>;
  notify(message: string): void;
};

/** A long link cut at the width (no padding, no word breaks): each piece links to the whole. */
function linkLines(url: string, width: number, style: (text: string) => string): string[] {
  const chars = [...url];
  const lines: string[] = [];
  for (let start = 0; start < chars.length; start += width) {
    lines.push(hyperlink(style(chars.slice(start, start + width).join("")), url));
  }
  return lines;
}

export class LoginView implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: () => Theme;
  private readonly payload: LoginPayload;
  private readonly answer: (answer: LoginAnswer) => void;
  private readonly actions: LoginActions;
  private readonly rows: LoginRow[];
  private readonly field: LineField | undefined;
  private selected: number;
  private focusedState = false;
  /** For each drawn line, the row it shows. */
  private lineRows: (number | undefined)[] = [];

  constructor(tui: TUI, theme: () => Theme, payload: LoginPayload, answer: (answer: LoginAnswer) => void, actions: LoginActions) {
    this.tui = tui;
    this.theme = theme;
    this.payload = payload;
    this.answer = answer;
    this.actions = actions;
    this.rows = loginRows(payload);
    this.selected = loginInitialRow(this.rows);
    const row = this.rows.find((candidate) => candidate.kind === "field");
    if (row?.kind === "field") {
      const field = new LineField({ prompt: "> ", ...(row.placeholder !== undefined ? { placeholder: row.placeholder, placeholderStyle: (text) => theme().fg("dim", text) } : {}), ...(row.secret ? { mask: "•" } : {}) });
      field.onSubmit = (value) => (value.trim() !== "" ? this.answer({ value }) : undefined);
      this.field = field;
    } else {
      this.field = undefined;
    }
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.syncField();
  }

  private fieldIndex(): number {
    return this.rows.findIndex((row) => row.kind === "field");
  }

  private syncField(): void {
    if (this.field !== undefined) {
      this.field.focused = this.focusedState && this.selected === this.fieldIndex();
    } else {
      // no field in this step
    }
  }

  private select(index: number): void {
    this.selected = index;
    this.syncField();
    this.tui.requestRender();
  }

  private apply(index: number): void {
    const row = this.rows[index];
    if (row === undefined) {
      return; // nothing there
    } else {
      switch (row.kind) {
        case "open":
          this.actions.open(row.url);
          break;
        case "copy":
          void this.actions.copy(row.text).then(
            () => this.actions.notify(`copied: ${row.label.replace(/^copy /, "")}`),
            (error: unknown) => this.actions.notify(`copy failed: ${error instanceof Error ? error.message : String(error)}`),
          );
          break;
        case "option":
          this.answer({ option: row.id });
          break;
        case "field":
          this.select(index);
          break;
        default:
          throw new Error(`unknown login row: ${JSON.stringify(row satisfies never)}`);
      }
    }
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const count = this.rows.length;
    const inField = this.field !== undefined && this.selected === this.fieldIndex();
    if (keys.matches(data, "tui.select.cancel")) {
      this.answer({ cancelled: true });
    } else if ((keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) && count > 0) {
      this.select((this.selected + (keys.matches(data, "tui.select.up") ? count - 1 : 1)) % count);
    } else if (inField) {
      this.field?.handleInput(data); // typing, the cursor's moves, deleting, paste, Enter submits
      this.tui.requestRender();
    } else if (matchesKey(data, "left")) {
      this.answer({ back: true });
    } else if (keys.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
      this.apply(this.selected);
    } else if (this.field !== undefined && !/^[\x00-\x1f\x7f]/.test(data)) {
      // typing or pasting goes to the field at once
      this.select(this.fieldIndex());
      this.field.handleInput(data);
    } else {
      // a key this step does not use
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const index = this.lineRows[event.y];
    if (index === undefined) {
      return undefined;
    } else if (event.type === "move") {
      const changed = index !== this.selected;
      this.selected = index;
      this.syncField();
      return { handled: true, render: changed };
    } else if (event.type === "click" && event.button === "left") {
      this.selected = index;
      this.syncField();
      this.apply(index);
      return { handled: true, render: true };
    } else {
      return { handled: true };
    }
  }

  invalidate(): void {
    this.field?.invalidate();
  }

  render(width: number): string[] {
    const theme = this.theme();
    const payload = this.payload;
    const text = (value: string, color: Parameters<Theme["fg"]>[0]): string[] => wrapTextWithAnsi(theme.fg(color, value), width);
    const lines: { line: string; row?: number }[] = [];
    const add = (values: string[], row?: number): void => {
      for (const line of values) {
        lines.push(row !== undefined ? { line, row } : { line });
      }
    };

    add([theme.fg("borderAccent", "─".repeat(width))]);
    add([theme.fg("accent", theme.bold(truncateToWidth(payload.title, width)))]);
    if (payload.url !== undefined) {
      add(linkLines(payload.url, width, (piece) => theme.fg("accent", piece)));
    } else {
      // no sign-in link in this step
    }
    if (payload.instructions !== undefined) {
      add(text(payload.instructions, "warning"));
    } else {
      // no instructions
    }
    if (payload.deviceCode !== undefined) {
      add(linkLines(payload.deviceCode.uri, width, (piece) => theme.fg("accent", piece)));
      add([theme.fg("warning", `code: ${payload.deviceCode.code}`)]);
    } else {
      // no device code
    }
    for (const progress of payload.progress) {
      add(text(progress, "muted"));
    }
    if (payload.prompt !== undefined) {
      add([""]);
      add(text(payload.prompt.message, "text"));
    } else {
      // nothing asked: the operator waits for the browser, or goes back, or cancels
    }

    this.rows.forEach((row, index) => {
      const selected = index === this.selected;
      if (row.kind === "field") {
        add([this.field?.render(width)[0] ?? ""], index);
      } else {
        const marker = selected ? theme.fg("accent", "▌") : " ";
        const label = row.kind === "option" && row.description !== undefined ? `${row.label} ${theme.fg("muted", row.description)}` : row.label;
        const line = truncateToWidth(`${marker}${selected ? theme.fg("accent", label) : label}`, width);
        add([selected ? theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))) : line], index);
      }
    });

    add([truncateToWidth(hintLine(theme, loginHints(this.rows)).trimStart(), width)]);
    add([theme.fg("borderAccent", "─".repeat(width))]);
    this.lineRows = lines.map((entry) => entry.row);
    return lines.map((entry) => entry.line);
  }
}
