// A virtual terminal for the TUI under test: pi-tui writes ANSI into a headless xterm of a fixed
// size, the test reads the screen back (text, cells with colors, raw ANSI) and sends input as the
// terminal would. Program status (OSC 7501) and the title are recorded for assertions.

import type { Terminal as TuiTerminal } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";

type ProgramStatus = Parameters<TuiTerminal["setProgramStatus"]>[0];

export type Cell = { chars: string; width: number; fg: string | undefined; bg: string | undefined; bold: boolean; italic: boolean; dim: boolean; underline: boolean; inverse: boolean };

/** The 16 ANSI colors as xterm.js draws them by default. */
const ANSI16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

function palette(index: number): string {
  if (index < 16) {
    return ANSI16[index] ?? "#ffffff";
  } else if (index < 232) {
    const value = index - 16;
    const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
    const hex = (n: number): string => level(n).toString(16).padStart(2, "0");
    return `#${hex(Math.floor(value / 36))}${hex(Math.floor(value / 6) % 6)}${hex(value % 6)}`;
  } else {
    const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
    return `#${gray}${gray}${gray}`;
  }
}

function rgb(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

export class VirtualTerminal implements TuiTerminal {
  readonly xterm: InstanceType<typeof xterm.Terminal>;
  /** Everything written, for the screen.ansi capture. */
  ansi = "";
  programStatus: ProgramStatus | undefined;
  title = "";
  private input: ((data: string) => void) | undefined;
  private resize: (() => void) | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(columns = 140, rows = 40) {
    this.xterm = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resize = onResize;
  }

  stop(): void {
    this.input = undefined;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.ansi += data;
    this.pending = this.pending.then(() => new Promise<void>((resolve) => this.xterm.write(data, resolve)));
  }

  /** Waits until everything written so far is on the screen. */
  flushed(): Promise<void> {
    return this.pending;
  }

  get columns(): number {
    return this.xterm.cols;
  }

  get rows(): number {
    return this.xterm.rows;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(lines: number): void {
    this.write(lines > 0 ? `\x1b[${lines}B` : lines < 0 ? `\x1b[${-lines}A` : "");
  }

  hideCursor(): void {
    this.write("\x1b[?25l");
  }

  showCursor(): void {
    this.write("\x1b[?25h");
  }

  clearLine(): void {
    this.write("\x1b[K");
  }

  clearFromCursor(): void {
    this.write("\x1b[J");
  }

  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }

  setTitle(title: string): void {
    this.title = title;
  }

  setProgress(): void {}

  setProgramStatus(status: ProgramStatus): void {
    this.programStatus = status;
  }

  /** Bytes as the terminal would send them for keys and typed text. */
  send(data: string): void {
    this.input?.(data);
  }

  resizeTo(columns: number, rows: number): void {
    this.xterm.resize(columns, rows);
    this.resize?.();
  }

  /** Where the terminal's own cursor stands on the visible screen (column, row). */
  cursor(): { x: number; y: number } {
    const buffer = this.xterm.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }

  /** The visible screen as text, one string per row, trailing spaces trimmed. */
  text(): string[] {
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.xterm.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }

  /** The visible screen as cells with resolved colors (undefined: the terminal's default). */
  cells(): Cell[][] {
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.xterm.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: this.xterm.cols }, (_, column) => {
        const cell = line?.getCell(column);
        if (cell === undefined) {
          return { chars: " ", width: 1, fg: undefined, bg: undefined, bold: false, italic: false, dim: false, underline: false, inverse: false };
        } else {
          const fg = cell.isFgRGB() ? rgb(cell.getFgColor()) : cell.isFgPalette() ? palette(cell.getFgColor()) : undefined;
          const bg = cell.isBgRGB() ? rgb(cell.getBgColor()) : cell.isBgPalette() ? palette(cell.getBgColor()) : undefined;
          return {
            chars: cell.getChars(),
            width: cell.getWidth(),
            fg,
            bg,
            bold: cell.isBold() !== 0,
            italic: cell.isItalic() !== 0,
            dim: cell.isDim() !== 0,
            underline: cell.isUnderline() !== 0,
            inverse: cell.isInverse() !== 0,
          };
        }
      });
    });
  }
}
