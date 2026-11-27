// The session's terminal over the main area (plan polish-3 F): a frame `╭─╮` in the accent border
// color, its title naming the directory and the key that hides it; inside, the hub's shell as the
// client's terminal model draws it, the terminal's own cursor where the shell's stands. While it is
// shown every key goes to the shell (Tab, Ctrl+C, Esc too) but the one that hides it: whatever form
// this terminal reports it in (legacy bytes, the kitty protocol, a repeat) it becomes one key, and
// the key the bytes the program inside asked for (terminal-keys.ts); releases are dropped, pasted
// text is bracketed only where the program asked. The wheel scrolls the history unless the program
// asked for the mouse; Shift+PgUp/PgDn always do. When the shell exited, Enter starts another.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, decodeKittyPrintable, isKeyRelease, matchesKey, parseKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { TerminalModel } from "#client/model/terminal-model.ts";
import { encodeKey, keyFromId, type KeyModes } from "#client/terminal-keys.ts";

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/** What this terminal reported, as the program inside reads it; "" for nothing it reads. */
export function shellBytes(data: string, modes: KeyModes & { bracketedPaste: boolean }): string {
  const pasted = PASTE.exec(data);
  const printable = decodeKittyPrintable(data);
  const id = parseKey(data);
  if (pasted !== null) {
    return modes.bracketedPaste ? data : (pasted[1] ?? "");
  } else if (isKeyRelease(data)) {
    return ""; // only presses (and repeats) type
  } else if (printable !== undefined) {
    return printable;
  } else if (/^[^\x00-\x1f\x7f]+$/.test(data)) {
    return data; // text as it came: characters are themselves
  } else if (id !== undefined) {
    return encodeKey(keyFromId(id), modes) ?? "";
  } else if (!data.startsWith("\x1b")) {
    return data; // text as it came (several characters, a character pi-tui has no name for)
  } else {
    return ""; // a sequence no key: nothing the program reads
  }
}

export class TerminalView implements Component, Focusable {
  private readonly model: TerminalModel;
  private readonly theme: () => Theme;
  private readonly height: () => number;
  private readonly hideKey: () => string;
  private readonly failed: (error: unknown) => void;
  focused = false;

  constructor(model: TerminalModel, theme: () => Theme, height: () => number, hideKey: () => string, failed: (error: unknown) => void) {
    this.model = model;
    this.theme = theme;
    this.height = height;
    this.hideKey = hideKey;
    this.failed = failed;
  }

  get terminal(): TerminalModel {
    return this.model;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const model = this.model;
    if (model.state === "exited" && matchesKey(data, "enter")) {
      void model.open(model.cols, model.rows).catch(this.failed);
    } else if (matchesKey(data, "shift+pageUp") || matchesKey(data, "shift+pageDown")) {
      model.scroll(matchesKey(data, "shift+pageUp") ? model.rows - 1 : -(model.rows - 1));
    } else if (model.state !== "exited") {
      // while the shell starts its keys wait in the model, in order
      const bytes = shellBytes(data, { ...model.keyModes, bracketedPaste: model.bracketedPaste });
      if (bytes !== "") {
        model.input(bytes);
      } else {
        // nothing the shell reads
      }
    } else {
      // exited: only Enter (above) starts another shell
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const model = this.model;
    const up = (event.wheelDelta ?? 0) < 0;
    if (event.type === "wheel" && !model.mouse) {
      return { handled: true, render: model.scroll(up ? 3 : -3) };
    } else if (event.type === "wheel") {
      // the program's own mouse: wheel as buttons 64/65 (SGR), at the cell under the pointer inside the frame
      model.input(`\x1b[<${up ? 64 : 65};${Math.max(1, event.x)};${Math.max(1, event.y)}M`);
      return { handled: true };
    } else {
      return { handled: true };
    }
  }

  render(width: number): string[] {
    const theme = this.theme();
    const model = this.model;
    const height = Math.max(4, this.height());
    const inner = Math.max(2, width - 2);
    const rows = height - 2;
    if (model.state === "closed") {
      void model.open(inner, rows).catch(this.failed);
    } else {
      model.resize(inner, rows);
    }

    const border = (text: string): string => theme.fg("borderAccent", text);
    const title = model.program.kind === "prompt" ? " message · the editor's exit puts it back " : ` terminal · ${model.cwd} · ${this.hideKey()} hide `;
    const shown = truncateToWidth(title, Math.max(0, inner - 2), "…");
    const top = border(`╭─${shown}${"─".repeat(Math.max(0, inner - 1 - visibleWidth(shown)))}╮`);
    const bottom = border(`╰${"─".repeat(inner)}╯`);

    const view = model.view(this.focused && model.state === "open" ? CURSOR_MARKER : undefined);
    const body = Array.from({ length: rows }, (_, row) => view.lines[row] ?? "");
    if (model.state === "exited") {
      body[rows - 1] = theme.fg("warning", `[exited ${model.exitCode ?? "?"}] · Enter restarts · ${this.hideKey()} hides`);
    } else if (model.state === "opening") {
      body[0] = theme.fg("dim", "starting…");
    } else {
      // the shell's screen
    }
    const side = border("│");
    return [top, ...body.map((line) => `${side}${truncateToWidth(line, inner, "", true)}\x1b[0m${side}`), bottom];
  }
}
