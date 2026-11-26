// The one single-line input of harness's own TUI (plan polish-3 B): pi-tui's Input — the arrows,
// Home/End, words, Delete, paste, undo, horizontal scrolling that keeps a column for the cursor at
// the end — without padding, its cursor the terminal's own (CURSOR_MARKER while focused, as in the
// chat's editor). A mask draws one bullet per character, the cursor where the typed one is.

import { Input, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

export type LineFieldOptions = {
  prompt?: string;
  placeholder?: string;
  placeholderStyle?: (text: string) => string;
  /** Drawn instead of each character (secrets). */
  mask?: string;
};

/** Input's cursor: an index into its value (private to pi-tui; line-field.test.ts holds it to that). */
type InputState = { cursor: number };

export class LineField implements Component, Focusable {
  private readonly input: Input;
  private readonly options: LineFieldOptions;
  /** A value typed, pasted or deleted (not one set from outside). */
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  constructor(options: LineFieldOptions = {}) {
    this.options = options;
    this.input = new Input({
      ...(options.prompt !== undefined ? { prompt: options.prompt } : { prompt: "" }),
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      ...(options.placeholderStyle !== undefined ? { placeholderStyle: options.placeholderStyle } : {}),
    });
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.onEscape = () => this.onEscape?.();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  get value(): string {
    return this.input.getValue();
  }

  /** A value from outside (the node's): the cursor goes to its end. */
  set value(value: string) {
    if (value !== this.input.getValue()) {
      this.input.setValue(value);
      (this.input as unknown as InputState).cursor = value.length;
    } else {
      // the same text: the cursor stays where the operator left it
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) {
      // Enter submits a line (harness binds pi-tui's tui.input.submit to the editor's Ctrl+Enter)
      this.onSubmit?.(this.input.getValue());
      return;
    } else {
      // a key for the field
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (after !== before) {
      this.onChange?.(after);
    } else {
      // a move, or a key the field does not use
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  /** One line, exactly `width` columns. */
  render(width: number): string[] {
    const mask = this.options.mask;
    if (mask === undefined) {
      return this.input.render(width);
    } else {
      // the same field over bullets: one per character, the cursor after as many as precede it
      const value = this.input.getValue();
      const cursor = (this.input as unknown as InputState).cursor;
      const twin = new Input({ prompt: this.options.prompt ?? "" });
      twin.setValue(mask.repeat([...value].length));
      (twin as unknown as InputState).cursor = mask.length * [...value.slice(0, cursor)].length;
      twin.focused = this.input.focused;
      return twin.render(width);
    }
  }
}
