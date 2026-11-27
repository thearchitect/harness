// A session's terminal as a client shows it (plan polish-3 F), the same for the TUI and the app: its
// own headless xterm gets the hub's screen (terminal_open) and then the stream; the UIs draw its
// visible rows as ANSI lines and put the cursor where it stands. Scrolling the history is this
// client's own. Input and the size go to the hub's shell.

import * as headless from "@xterm/headless";
import type { HubApi } from "./client-model.ts";

/**
 * The package is CommonJS marked __esModule: Node's ESM puts it under `default`, Metro's interop
 * gives its exports directly.
 */
const xterm = (headless as { default?: typeof headless }).default ?? headless;

/** History lines a client keeps (the hub keeps as many). */
const SCROLLBACK = 10_000;

type Cell = NonNullable<ReturnType<NonNullable<ReturnType<InstanceType<typeof xterm.Terminal>["buffer"]["active"]["getLine"]>>["getCell"]>>;

/** The SGR of a cell's colors and styles (a full reset first, so each run stands alone). */
function sgr(cell: Cell): string {
  const codes = ["0"];
  if (cell.isBold() !== 0) codes.push("1");
  if (cell.isDim() !== 0) codes.push("2");
  if (cell.isItalic() !== 0) codes.push("3");
  if (cell.isUnderline() !== 0) codes.push("4");
  if (cell.isInverse() !== 0) codes.push("7");
  if (cell.isInvisible() !== 0) codes.push("8");
  if (cell.isStrikethrough() !== 0) codes.push("9");
  const color = (rgb: boolean, palette: boolean, value: number, base: 38 | 48): void => {
    if (rgb) {
      codes.push(`${base};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`);
    } else if (palette) {
      codes.push(`${base};5;${value}`);
    } else {
      // the default color
    }
  };
  color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 38);
  color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 48);
  return `\x1b[${codes.join(";")}m`;
}

export type TerminalState = "closed" | "opening" | "open" | "exited";

export class TerminalModel {
  readonly hub: string;
  readonly session: string;
  readonly cwd: string;
  private readonly api: () => HubApi;
  private readonly term: InstanceType<typeof xterm.Terminal>;
  private readonly changed: () => void;
  state: TerminalState = "closed";
  exitCode: number | undefined;
  /** Lines scrolled up from the bottom (this client's own). */
  private scrolled = 0;
  /** Input typed while the shell starts: sent, in order, once it runs. */
  private held: string[] = [];

  constructor(node: string, session: string, cwd: string, api: () => HubApi, changed: () => void) {
    this.hub = node;
    this.session = session;
    this.cwd = cwd;
    this.api = api;
    this.changed = changed;
    this.term = new xterm.Terminal({ cols: 80, rows: 24, scrollback: SCROLLBACK, allowProposedApi: true });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Shows it at a size: the hub starts the shell (again after it exited) and sends its screen. */
  async open(cols: number, rows: number): Promise<void> {
    if (this.state === "opening" || this.state === "open") {
      return;
    } else {
      this.state = "opening";
      this.exitCode = undefined;
      this.term.resize(Math.max(2, cols), Math.max(1, rows));
      const { screen } = await this.api().request("terminal_open", { session: this.session, cwd: this.cwd, cols: this.term.cols, rows: this.term.rows });
      const held = this.held;
      this.held = [];
      for (const data of held) {
        this.send(data);
      }
      this.term.reset();
      this.scrolled = 0;
      this.term.write(screen, () => {
        this.state = this.state === "opening" ? "open" : this.state;
        this.changed();
      });
    }
  }

  /** Hidden: the hub stops sending it here; the shell runs on. */
  detach(): void {
    if (this.state === "open" || this.state === "opening") {
      this.state = "closed";
      void this.api()
        .request("terminal_detach", { session: this.session })
        .catch(() => undefined);
    } else {
      // not shown
    }
  }

  output(data: string): void {
    this.term.write(data, () => this.changed());
  }

  exited(code: number): void {
    this.state = "exited";
    this.exitCode = code;
    this.changed();
  }

  input(data: string): void {
    this.scrolled = 0; // typing shows the bottom
    if (this.state === "opening") {
      this.held.push(data);
    } else {
      this.send(data);
    }
  }

  private send(data: string): void {
    void this.api()
      .request("terminal_input", { session: this.session, data })
      .catch(() => undefined);
  }

  resize(cols: number, rows: number): void {
    const width = Math.max(2, Math.floor(cols));
    const height = Math.max(1, Math.floor(rows));
    if (width !== this.term.cols || height !== this.term.rows) {
      this.term.resize(width, height);
      void this.api()
        .request("terminal_resize", { session: this.session, cols: width, rows: height })
        .catch(() => undefined);
    } else {
      // that size already
    }
  }

  /** Scrolls this client's view of the history (positive: up); returns whether it moved. */
  scroll(lines: number): boolean {
    const history = this.term.buffer.active.baseY;
    const next = Math.max(0, Math.min(history, this.scrolled + lines));
    const moved = next !== this.scrolled;
    this.scrolled = next;
    return moved;
  }

  /** Whether the program in it asked for mouse events (then the wheel is its, not the history's). */
  get mouse(): boolean {
    return this.term.modes.mouseTrackingMode !== "none";
  }

  /** Whether the program in it takes pasted text bracketed. */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** Whether the program asked for application cursor keys (arrows as ESC O A). */
  get applicationCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /**
   * The visible rows as ANSI lines, and the cursor on them (undefined while the history is scrolled);
   * `marker` goes before the cursor's cell (the TUI's CURSOR_MARKER puts the terminal's cursor there).
   */
  view(marker?: string): { lines: string[]; cursor: { x: number; y: number } | undefined } {
    const buffer = this.term.buffer.active;
    const top = Math.max(0, buffer.baseY - this.scrolled);
    const cursor = this.scrolled === 0 ? { x: buffer.cursorX, y: buffer.cursorY } : undefined;
    const lines: string[] = [];
    for (let row = 0; row < this.term.rows; row += 1) {
      const line = buffer.getLine(top + row);
      let text = "";
      let style = "";
      for (let column = 0; line !== undefined && column < this.term.cols; column += 1) {
        const cell = line.getCell(column);
        if (cell === undefined || cell.getWidth() === 0) {
          continue; // the second half of a wide character
        } else {
          const next = sgr(cell);
          text += next !== style ? next : "";
          style = next;
          text += marker !== undefined && cursor !== undefined && cursor.y === row && cursor.x === column ? marker : "";
          text += cell.getChars() === "" ? " " : cell.getChars();
        }
      }
      lines.push(`${text}\x1b[0m`);
    }
    return { lines, cursor };
  }

  dispose(): void {
    this.term.dispose();
  }
}
