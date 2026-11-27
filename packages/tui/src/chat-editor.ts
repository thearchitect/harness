// The chat's field: pi-tui's editor with two of harness's own ways.
//   Completion (`/`, `@`) shows as a block above the field, not below it: one top line in the
//   `border` color with the block's name on it (commands, files), the list, a line of its keys;
//   the field stays where it is and keeps the focus.
//   The cursor keeps `scrollOff` lines above and below it while the text has them (the field shows
//   at most 30% of the terminal's rows and scrolls); at the text's ends it comes to the edge.

import { Editor, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

/** What pi-tui's editor keeps to itself and this one reads: its layout and what it drew last. */
type EditorInternals = {
  scrollOffset: number;
  paddingX: number;
  renderedVisibleLineCount: number;
  renderedAutocompleteHeight: number;
  autocompleteState: unknown;
  layoutText(width: number): { hasCursor: boolean }[];
};

export type ChatEditorOptions = {
  border: (text: string) => string;
  dim: (text: string) => string;
  /** Lines kept above and below the cursor (`ui.scrollOff.vertical`). */
  scrollOff: () => number;
};

export class ChatEditor extends Editor {
  private readonly chat: ChatEditorOptions;
  private readonly host: TUI;

  constructor(tui: TUI, theme: ConstructorParameters<typeof Editor>[1], chat: ChatEditorOptions) {
    super(tui, theme, { paddingX: 0 });
    this.host = tui;
    this.chat = chat;
  }

  private get internals(): EditorInternals {
    return this as unknown as EditorInternals;
  }

  /** The block's name: commands at a leading `/`, files after an `@`. */
  private blockName(): string {
    const cursor = this.getCursor();
    const before = (this.getText().split("\n")[cursor.line] ?? "").slice(0, cursor.col);
    return /^\/\S*$/.test(before) ? "commands" : /@\S*$/.test(before) ? "files" : "completions";
  }

  /** The scroll offset that keeps `scrollOff` lines around the cursor where the text has them. */
  private keepScrollOff(width: number): void {
    const internals = this.internals;
    const content = Math.max(1, width - internals.paddingX * 2);
    const lines = internals.layoutText(Math.max(1, content - (internals.paddingX > 0 ? 0 : 1)));
    const visible = Math.max(5, Math.floor(this.host.terminal.rows * 0.3));
    const cursor = Math.max(0, lines.findIndex((line) => line.hasCursor));
    const margin = Math.min(this.chat.scrollOff(), Math.floor((visible - 1) / 2));
    const offset = internals.scrollOffset;
    const wanted = cursor < offset + margin ? cursor - margin : cursor > offset + visible - 1 - margin ? cursor - visible + 1 + margin : offset;
    internals.scrollOffset = Math.max(0, Math.min(wanted, Math.max(0, lines.length - visible)));
  }

  override render(width: number): string[] {
    this.keepScrollOff(width);
    const lines = super.render(width);
    const height = this.internals.renderedAutocompleteHeight;
    if (height === 0) {
      return lines;
    } else {
      const name = ` ${this.blockName()} `;
      const top = this.chat.border(`──${name}${"─".repeat(Math.max(0, width - 2 - name.length))}`);
      const hint = this.chat.dim(truncateToWidth("↑↓ choose · Tab/Enter insert · Esc close", width));
      return [top, ...lines.slice(lines.length - height), hint, ...lines.slice(0, lines.length - height)];
    }
  }

  /** Rows as drawn here, as pi-tui's editor counts them: its field first, the list under it. */
  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const internals = this.internals;
    const height = internals.autocompleteState !== undefined && internals.autocompleteState !== null ? internals.renderedAutocompleteHeight : 0;
    if (height === 0) {
      return super.handleMouse(event);
    } else if (event.y >= 1 && event.y < 1 + height) {
      return super.handleMouse({ ...event, y: event.y - 1 + internals.renderedVisibleLineCount + 2 });
    } else if (event.y < height + 2) {
      return { handled: true, focus: true }; // the block's top line and its keys
    } else {
      return super.handleMouse({ ...event, y: event.y - height - 2 });
    }
  }
}
