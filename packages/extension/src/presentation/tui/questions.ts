// The `questions` interaction in the TUI, in the editor's place: one question at a time — its
// context, the options (Space toggles with several allowed), "✎ my own answer", and a comment line.
// Keys: ↑/↓ choose, Space toggle, Enter confirm (on "my own answer": write it), Tab → comment,
// Esc dismiss (in a text field: back to the options).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, getKeybindings, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { QuestionAnswer, QuestionsAnswer, QuestionsPayload } from "#protocol/interactions.ts";
import { bottomBorder, padLine, selectListTheme, topBorder } from "./gate.ts";

type Zone = "options" | "freeform" | "comment";

export class QuestionsDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly payload: QuestionsPayload;
  private readonly done: (answer: QuestionsAnswer) => void;
  private readonly answers: QuestionAnswer[] = [];
  private index = 0;
  private cursor = 0;
  private checked = new Set<number>();
  private zone: Zone = "options";
  private readonly freeform: Editor;
  private readonly comment: Editor;
  private focusedState = false;

  constructor(tui: TUI, theme: Theme, payload: QuestionsPayload, done: (answer: QuestionsAnswer) => void) {
    this.tui = tui;
    this.theme = theme;
    this.payload = payload;
    this.done = done;
    const editorTheme = { borderColor: (s: string) => theme.fg("accent", s), selectList: selectListTheme(theme) };
    this.freeform = new Editor(tui, editorTheme, { paddingX: 1 });
    this.comment = new Editor(tui, editorTheme, { paddingX: 1 });
    this.freeform.disableSubmit = true;
    this.comment.disableSubmit = true;
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.syncFocus();
  }

  private syncFocus(): void {
    this.freeform.focused = this.focusedState && this.zone === "freeform";
    this.comment.focused = this.focusedState && this.zone === "comment";
  }

  invalidate(): void {
    this.freeform.invalidate();
    this.comment.invalidate();
  }

  private get question() {
    const question = this.payload.questions[this.index];
    if (question === undefined) {
      throw new Error(`no question ${this.index}`);
    } else {
      return question;
    }
  }

  /** Options, then "my own answer" when freeform answers are allowed. */
  private get rowCount(): number {
    return this.question.options.length + (this.question.allowFreeform ? 1 : 0);
  }

  private setZone(zone: Zone): void {
    this.zone = zone;
    this.syncFocus();
    this.tui.requestRender();
  }

  private confirm(): void {
    const options = this.question.options;
    const selected = this.question.allowMultiple
      ? [...this.checked].sort((a, b) => a - b).flatMap((i) => (options[i] !== undefined ? [options[i].title] : []))
      : this.cursor < options.length && options[this.cursor] !== undefined
        ? [options[this.cursor]?.title ?? ""]
        : [];
    const freeform = this.freeform.getText().trim();
    const comment = this.comment.getText().trim();
    this.answers.push({ selected, freeform: freeform !== "" ? freeform : undefined, comment: comment !== "" ? comment : undefined });
    if (this.index + 1 < this.payload.questions.length) {
      this.index += 1;
      this.cursor = 0;
      this.checked = new Set();
      this.freeform.setText("");
      this.comment.setText("");
      this.setZone("options");
    } else {
      this.done({ answers: this.answers });
    }
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (this.zone !== "options") {
      const editor = this.zone === "freeform" ? this.freeform : this.comment;
      if (matchesKey(data, Key.ctrl("enter"))) {
        this.confirm();
      } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
        this.setZone("options");
      } else {
        editor.handleInput(data);
        this.tui.requestRender();
      }
    } else if (keys.matches(data, "tui.select.up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.tui.requestRender();
    } else if (keys.matches(data, "tui.select.down")) {
      this.cursor = Math.min(this.rowCount - 1, this.cursor + 1);
      this.tui.requestRender();
    } else if (matchesKey(data, Key.space) && this.question.allowMultiple && this.cursor < this.question.options.length) {
      if (this.checked.has(this.cursor)) {
        this.checked.delete(this.cursor);
      } else {
        this.checked.add(this.cursor);
      }
      this.tui.requestRender();
    } else if (keys.matches(data, "tui.select.confirm")) {
      if (this.cursor >= this.question.options.length) {
        this.setZone("freeform");
      } else {
        this.confirm();
      }
    } else if (matchesKey(data, Key.tab)) {
      this.setZone("comment");
    } else if (keys.matches(data, "tui.select.cancel")) {
      this.done({ cancelled: true });
    } else {
      // a key the options do not use
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(10, width - 2);
    const question = this.question;
    const counter = this.payload.questions.length > 1 ? ` ${this.index + 1}/${this.payload.questions.length}` : "";
    const lines = [topBorder(theme, width, `Question${counter}`)];
    if (question.context !== undefined && question.context !== "") {
      lines.push(...wrapTextWithAnsi(theme.fg("muted", question.context), inner).map((line) => ` ${line}`), "");
    } else {
      // no context
    }
    lines.push(...wrapTextWithAnsi(theme.bold(question.question), inner).map((line) => ` ${line}`), "");
    question.options.forEach((option, row) => {
      const mark = question.allowMultiple ? (this.checked.has(row) ? "[x]" : "[ ]") : row === this.cursor ? "●" : "○";
      const text = `${row === this.cursor ? "›" : " "} ${mark} ${option.title}`;
      lines.push(truncateToWidth(row === this.cursor && this.zone === "options" ? theme.fg("accent", theme.bold(text)) : text, width));
      if (option.description !== undefined && option.description !== "") {
        lines.push(...wrapTextWithAnsi(theme.fg("muted", option.description), inner - 6).map((line) => `      ${line}`));
      } else {
        // a bare option
      }
    });
    if (question.allowFreeform) {
      const row = question.options.length;
      const text = `${row === this.cursor ? "›" : " "} ✎ my own answer`;
      lines.push(row === this.cursor && this.zone === "options" ? theme.fg("accent", theme.bold(text)) : text);
      if (this.zone === "freeform" || this.freeform.getText() !== "") {
        lines.push(...this.freeform.render(width));
      } else {
        // the answer field opens on Enter
      }
    } else {
      // options only
    }
    if (this.zone === "comment" || this.comment.getText() !== "") {
      lines.push(theme.fg("dim", " comment:"), ...this.comment.render(width));
    } else {
      // the comment opens on Tab
    }
    const help =
      this.zone === "options"
        ? `↑/↓ choose${question.allowMultiple ? " · Space toggle" : ""} · Enter confirm · Tab comment · Esc dismiss`
        : "Enter newline · Ctrl+Enter confirm · Esc/Tab → options";
    lines.push("", padLine(` ${theme.fg("dim", help)}`, width), bottomBorder(theme, width));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
