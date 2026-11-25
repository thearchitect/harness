// The `gate` interaction in the TUI, in the editor's place: options on the left (Yes / No (why?) /
// Stop), a multiline comment on the right. Yes with a comment is "allow with comment"; No needs a
// comment (the model sees it); Stop and Esc end the run.
//
// Keys — options: ↑/↓ choose, Enter submit, Tab → comment, typing jumps into the comment, Esc = Stop.
// Comment: Enter newline, Ctrl+Enter submit, Tab/Esc → options.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Editor, getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { GateAnswer, GatePayload } from "#protocol/interactions.ts";

const MIN_EDITOR_WIDTH = 34;
const LEFT_WIDTH = 24;

const OPTIONS: readonly { action: GateAnswer["action"]; label: string }[] = [
  { action: "allow", label: "Yes" },
  { action: "reject", label: "No (why?)" },
  { action: "stop", label: "Stop" },
];

export function selectListTheme(theme: Theme): EditorTheme["selectList"] {
  return {
    selectedPrefix: (t: string): string => theme.fg("accent", t),
    selectedText: (t: string): string => theme.fg("accent", t),
    description: (t: string): string => theme.fg("muted", t),
    scrollInfo: (t: string): string => theme.fg("dim", t),
    noMatch: (t: string): string => theme.fg("warning", t),
  };
}

export function topBorder(theme: Theme, width: number, title: string): string {
  const inner = Math.max(1, width - 2);
  const label = ` ${title} `;
  if (inner < label.length + 2) {
    return theme.fg("accent", `╭${"─".repeat(inner)}╮`);
  } else {
    return theme.fg("accent", "╭─") + theme.fg("dim", theme.bold(label)) + theme.fg("accent", `${"─".repeat(Math.max(0, inner - 1 - label.length))}╮`);
  }
}

export function bottomBorder(theme: Theme, width: number): string {
  return theme.fg("accent", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
}

export function padLine(line: string, width: number): string {
  const used = visibleWidth(line);
  return used >= width ? line : line + " ".repeat(width - used);
}

/** The first printable character of the input, or undefined for controls. */
export function printableChar(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) {
    return kitty;
  } else {
    const characters = [...data];
    const character = characters[0];
    if (characters.length !== 1 || character === undefined) {
      return undefined;
    } else {
      const code = character.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? undefined : character;
    }
  }
}

export class GateDialog implements Component {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly payload: GatePayload;
  private readonly done: (answer: GateAnswer) => void;
  private selected = 0;
  private zone: "options" | "comment" = "options";
  private warning: string | undefined;
  private focusedState = false;

  constructor(tui: TUI, theme: Theme, payload: GatePayload, done: (answer: GateAnswer) => void) {
    this.tui = tui;
    this.theme = theme;
    this.payload = payload;
    this.done = done;
    this.editor = new Editor(tui, { borderColor: (s) => theme.fg(this.zone === "comment" ? "accent" : "borderMuted", s), selectList: selectListTheme(theme) }, { paddingX: 1 });
    this.editor.disableSubmit = true;
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.editor.focused = value && this.zone === "comment";
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private setZone(zone: "options" | "comment"): void {
    this.zone = zone;
    this.editor.focused = zone === "comment" && this.focusedState;
    this.tui.requestRender();
  }

  private submit(): void {
    const option = OPTIONS[this.selected] ?? OPTIONS[0];
    const comment = this.editor.getText().trim();
    if (option?.action === "reject" && comment === "") {
      this.warning = "No (why?) requires a comment — say what is wrong / what to fix";
      this.setZone("comment");
    } else if (option !== undefined) {
      this.warning = undefined;
      this.done({ action: option.action, comment: comment !== "" ? comment : undefined });
    } else {
      throw new Error("the gate has no options");
    }
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (this.zone === "comment") {
      if (matchesKey(data, Key.ctrl("enter"))) {
        this.submit();
      } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.setZone("options");
      } else if (keys.matches(data, "tui.input.submit")) {
        this.editor.insertTextAtCursor("\n");
        this.tui.requestRender();
      } else {
        this.editor.handleInput(data);
        this.tui.requestRender();
      }
    } else if (keys.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.warning = undefined;
      this.tui.requestRender();
    } else if (keys.matches(data, "tui.select.down")) {
      this.selected = Math.min(OPTIONS.length - 1, this.selected + 1);
      this.warning = undefined;
      this.tui.requestRender();
    } else if (keys.matches(data, "tui.select.confirm")) {
      this.submit();
    } else if (keys.matches(data, "tui.select.cancel")) {
      this.done({ action: "stop" });
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.setZone("comment");
    } else if (printableChar(data) !== undefined) {
      this.setZone("comment");
      this.editor.handleInput(data);
      this.tui.requestRender();
    } else {
      // a key the options zone does not use
    }
  }

  private optionRow(index: number, width: number): string {
    const option = OPTIONS[index];
    const selected = index === this.selected;
    const line = `${selected ? "●" : "○"} ${option?.label ?? ""}`;
    const styled =
      this.zone === "comment"
        ? this.theme.fg(selected ? "accent" : "muted", line)
        : selected
          ? this.theme.fg("accent", this.theme.bold(line))
          : this.theme.fg("text", line);
    return truncateToWidth(styled, width, "", true);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const by = this.payload.by !== undefined ? ` — ${this.payload.by}` : "";
    const lines: string[] = [topBorder(theme, width, `${this.payload.title}${by}`)];
    for (const detail of this.payload.detail) {
      lines.push(padLine(truncateToWidth(theme.fg("muted", detail), width - 2, "", false), width));
    }
    lines.push("");

    const split = width >= LEFT_WIDTH + 1 + MIN_EDITOR_WIDTH;
    const rightWidth = split ? width - LEFT_WIDTH - 1 : width;
    const editorLines = this.editor.render(rightWidth).map((line) => padLine(line, rightWidth));
    if (split) {
      const rows = Math.max(OPTIONS.length, editorLines.length);
      for (let row = 0; row < rows; row++) {
        const left = row < OPTIONS.length ? this.optionRow(row, LEFT_WIDTH) : " ".repeat(LEFT_WIDTH);
        lines.push(`${left} ${editorLines[row] ?? " ".repeat(rightWidth)}`);
      }
    } else {
      for (let row = 0; row < OPTIONS.length; row++) {
        lines.push(this.optionRow(row, width));
      }
      lines.push("", ...editorLines);
    }

    lines.push("");
    const target = OPTIONS[this.selected]?.label ?? "";
    const status =
      this.warning ??
      (this.zone === "comment" ? `submit: ${target} · Enter newline · Ctrl+Enter submit · Tab/Esc → options` : "↑/↓ choose · Enter submit · Tab → comment · Esc = Stop");
    const zone = theme.fg("accent", this.zone === "comment" ? "▸ comment" : "▸ options");
    lines.push(padLine(truncateToWidth(`${zone} ${this.warning !== undefined ? theme.fg("warning", status) : theme.fg("dim", status)}`, width - 2, "", false), width));
    lines.push(bottomBorder(theme, width));
    return lines;
  }
}

/** The operator's comment under an approved change's row (from the result's details). */
export class GateCommentRow implements Component {
  private readonly base: Component;
  private readonly theme: Theme;
  private readonly comment: string;

  constructor(base: Component, theme: Theme, comment: string) {
    this.base = base;
    this.theme = theme;
    this.comment = comment;
  }

  invalidate(): void {
    this.base.invalidate();
  }

  render(width: number): string[] {
    const label = `${this.theme.fg("dim", "✻ your comment:")} ${this.comment}`;
    return [...this.base.render(width), "", ...wrapTextWithAnsi(label, Math.max(8, width)).map((line) => padLine(line, width))];
  }
}
