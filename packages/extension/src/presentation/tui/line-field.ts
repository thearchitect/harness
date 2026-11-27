// The one single-line input of harness's own TUI (plan polish-3 B): pi-tui's Input — the arrows,
// Home/End, words, Delete, paste, undo — without padding, its cursor the terminal's own
// (CURSOR_MARKER while focused, as in the chat's editor), drawn here: a column kept for the cursor
// at the end, and while the text goes on the cursor stays `scrollOff` columns from either edge (10
// by default; at the text's ends it comes to the edge). A mask draws one bullet per character, the
// cursor where the typed one is.

import { CURSOR_MARKER, Input, matchesKey, renderFakeCursor, sliceByColumn, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

export type LineFieldOptions = {
  prompt?: string;
  placeholder?: string;
  placeholderStyle?: (text: string) => string;
  /** Drawn instead of each character (secrets). */
  mask?: string;
  /** Columns kept on either side of the cursor while the text goes on (`ui.scrollOff.horizontal`). */
  scrollOff?: () => number;
};

/** Input's state (private to pi-tui; line-field.test.ts holds it to that): the cursor, an index into its value; the first column shown, which its mouse reads. */
type InputState = { cursor: number; renderedStartColumn: number };

/** The columns every field keeps around its cursor unless it names its own: the window's setting. */
let windowScrollOff = 10;

/** The window's `ui.scrollOff.horizontal`, for every field it draws. */
export function setLineFieldScrollOff(columns: number): void {
  windowScrollOff = columns;
}

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

  /** A value from outside (the hub's): the cursor goes to its end. */
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

  /** The first column shown: kept between draws, so the text moves only when the cursor nears an edge. */
  private startColumn = 0;

  /** One line, exactly `width` columns. */
  render(width: number): string[] {
    const prompt = this.options.prompt ?? "";
    const available = width - visibleWidth(prompt);
    const state = this.input as unknown as InputState;
    const typed = this.input.getValue();
    const mask = this.options.mask;
    // a mask: one bullet per character, the cursor after as many as precede it
    const value = mask === undefined ? typed : mask.repeat([...typed].length);
    const cursor = mask === undefined ? state.cursor : mask.length * [...typed.slice(0, state.cursor)].length;
    if (available <= 1) {
      return [truncateToWidth(prompt, width, "")];
    } else if (value === "" && this.options.placeholder !== undefined) {
      return this.input.render(width); // pi-tui's placeholder, the cursor on its first character
    } else {
      // the last column is the cursor's: the text gets the rest
      const columns = available - 1;
      const total = visibleWidth(value);
      const at = visibleWidth(value.slice(0, cursor));
      const margin = Math.min(this.options.scrollOff?.() ?? windowScrollOff, Math.floor((columns - 1) / 2));
      const kept = at < this.startColumn + margin ? at - margin : at > this.startColumn + columns - margin ? at - columns + margin : this.startColumn;
      this.startColumn = Math.max(0, Math.min(kept, Math.max(0, total - columns)));
      state.renderedStartColumn = this.startColumn;

      const shown = sliceByColumn(value, this.startColumn, columns + 1, true);
      const before = sliceByColumn(value, this.startColumn, at - this.startColumn, true);
      const rest = shown.slice(before.length);
      const under = [...new Intl.Segmenter().segment(rest)][0]?.segment ?? " ";
      const line = `${before}${this.input.focused ? CURSOR_MARKER : ""}${renderFakeCursor(under)}${rest.slice(under.length)}`;
      return [truncateToWidth(`${prompt}${line}${" ".repeat(Math.max(0, available - visibleWidth(line)))}`, width, "")];
    }
  }
}
