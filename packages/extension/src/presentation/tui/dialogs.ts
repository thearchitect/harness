// The `choice` interaction and foreign packages' `pi-dialog`s in the TUI: a titled list, a yes/no,
// a single-line input, a multiline editor — each in the editor's place.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, getKeybindings, Input, Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ChoiceAnswer, ChoicePayload, PiDialogAnswer, PiDialogPayload } from "#protocol/interactions.ts";
import { bottomBorder, selectListTheme, topBorder } from "./gate.ts";

/** A framed component: title, text, the body, a help line. */
class Framed implements Component {
  private readonly theme: Theme;
  private readonly title: string;
  private readonly message: string | undefined;
  readonly body: Component & { focused?: boolean };
  private readonly help: string;

  constructor(theme: Theme, title: string, message: string | undefined, body: Component & { focused?: boolean }, help: string) {
    this.theme = theme;
    this.title = title;
    this.message = message;
    this.body = body;
    this.help = help;
  }

  get focused(): boolean {
    return this.body.focused === true;
  }

  set focused(value: boolean) {
    this.body.focused = value;
  }

  handleInput(data: string): void {
    this.body.handleInput?.(data);
  }

  invalidate(): void {
    this.body.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    const [first, ...rest] = this.title.split("\n");
    return [
      topBorder(this.theme, width, first ?? ""),
      ...rest.flatMap((line) => wrapTextWithAnsi(this.theme.fg("muted", line), inner).map((wrapped) => ` ${wrapped}`)),
      ...(this.message !== undefined && this.message !== "" ? wrapTextWithAnsi(this.message, inner).map((line) => ` ${line}`) : []),
      ...this.body.render(width),
      ` ${this.theme.fg("dim", this.help)}`,
      bottomBorder(this.theme, width),
    ].map((line) => truncateToWidth(line, width));
  }
}

function list(theme: Theme, items: { value: string; label: string; description?: string }[], done: (value: string | undefined) => void): SelectList {
  const select = new SelectList(items, Math.min(12, Math.max(1, items.length)), selectListTheme(theme));
  select.onSelect = (item) => done(item.value);
  select.onCancel = () => done(undefined);
  return select;
}

export function choiceDialog(theme: Theme, payload: ChoicePayload, done: (answer: ChoiceAnswer) => void): Component {
  const select = list(
    theme,
    payload.options.map((option) => ({ value: option.id, label: option.title, description: option.description })),
    (value) => done(value !== undefined ? { id: value } : { cancelled: true }),
  );
  return new Framed(theme, payload.title, payload.message, select, "↑/↓ choose · Enter confirm · Esc dismiss");
}

/** A single-line input that also cancels on Escape. */
class LineInput implements Component {
  private readonly input = new Input();
  focused = false;

  constructor(done: (value: string | undefined) => void) {
    this.input.onSubmit = (value) => done(value);
    this.input.onEscape = () => done(undefined);
  }

  handleInput(data: string): void {
    this.input.focused = this.focused;
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    this.input.focused = this.focused;
    return this.input.render(width);
  }
}

/** A multiline editor: Ctrl+Enter submits, Esc cancels. */
class TextEditor implements Component {
  private readonly editor: Editor;
  private readonly done: (value: string | undefined) => void;

  constructor(tui: TUI, theme: Theme, prefill: string | undefined, done: (value: string | undefined) => void) {
    this.editor = new Editor(tui, { borderColor: (s) => theme.fg("accent", s), selectList: selectListTheme(theme) }, { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(prefill ?? "");
    this.done = done;
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("enter"))) {
      this.done(this.editor.getText());
    } else if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.done(undefined);
    } else {
      this.editor.handleInput(data);
    }
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    return this.editor.render(width);
  }
}

export function piDialog(tui: TUI, theme: Theme, payload: PiDialogPayload, done: (answer: PiDialogAnswer) => void): Component {
  const method = payload.method;
  switch (method) {
    case "select":
      return new Framed(
        theme,
        payload.title,
        undefined,
        list(theme, payload.options.map((option) => ({ value: option, label: option })), (value) => done(value !== undefined ? { value } : { cancelled: true })),
        "↑/↓ choose · Enter confirm · Esc dismiss",
      );
    case "confirm":
      return new Framed(
        theme,
        payload.title,
        payload.message,
        list(theme, [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], (value) => done(value !== undefined ? { confirmed: value === "yes" } : { cancelled: true })),
        "↑/↓ choose · Enter confirm · Esc dismiss",
      );
    case "input":
      return new Framed(theme, payload.title, payload.placeholder, new LineInput((value) => done(value !== undefined ? { value } : { cancelled: true })), "Enter confirm · Esc dismiss");
    case "editor":
      return new Framed(theme, payload.title, undefined, new TextEditor(tui, theme, payload.prefill, (value) => done(value !== undefined ? { value } : { cancelled: true })), "Ctrl+Enter confirm · Esc dismiss");
    default:
      throw new Error(`unknown dialog: ${String(method satisfies never)}`);
  }
}
