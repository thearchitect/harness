// Choosing where a new session starts, drawn in the chat zone (the model: client/workbench/
// new-session.ts). The title, the filter as typed, then the rows: `folder ⇒` or `· this folder`
// first, folders with `›` when they hold folders, recent ones with their age dimmed. It takes the
// keyboard while shown (no field, no focus to move): printable keys filter, the arrows choose and
// move between folders. A click chooses a row (Enter), a click on its `›` opens it (→).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { NewSession, NewSessionKey, NewSessionRow } from "#client/workbench/new-session.ts";

/** Lines above the rows: the title, the filter, a blank line. */
const HEAD = 3;

function keyOf(data: string): NewSessionKey | undefined {
  const keys = getKeybindings();
  if (keys.matches(data, "tui.select.up")) {
    return "up";
  } else if (keys.matches(data, "tui.select.down")) {
    return "down";
  } else if (keys.matches(data, "tui.select.pageUp")) {
    return "pageUp";
  } else if (keys.matches(data, "tui.select.pageDown")) {
    return "pageDown";
  } else if (matchesKey(data, Key.home)) {
    return "home";
  } else if (matchesKey(data, Key.end)) {
    return "end";
  } else if (matchesKey(data, Key.right)) {
    return "right";
  } else if (matchesKey(data, Key.left)) {
    return "left";
  } else if (keys.matches(data, "tui.select.confirm")) {
    return "enter";
  } else if (keys.matches(data, "tui.select.cancel")) {
    return "escape";
  } else if (keys.matches(data, "tui.editor.deleteCharBackward")) {
    return "backspace";
  } else if (visibleWidth(data) > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    return { char: data };
  } else {
    return undefined;
  }
}

export class NewSessionView implements Component, Focusable {
  focused = false;
  choice: NewSession;
  private readonly theme: () => Theme;
  private readonly height: () => number;
  private readonly failed: (error: unknown) => void;
  /** The first row drawn (the list scrolls to keep the chosen row in sight). */
  private top = 0;
  /** For each drawn line, the row index it shows. */
  private lineRows: (number | undefined)[] = [];

  constructor(choice: NewSession, theme: () => Theme, height: () => number, failed: (error: unknown) => void) {
    this.choice = choice;
    this.theme = theme;
    this.height = height;
    this.failed = failed;
  }

  invalidate(): void {}

  private rowText(row: NewSessionRow, width: number): string {
    const theme = this.theme();
    switch (row.kind) {
      case "browse":
        return theme.fg("accent", "folder ⇒");
      case "here":
        return theme.fg("accent", "· this folder");
      case "dir": {
        const arrow = row.hasChildren ? theme.fg("muted", " ›") : "";
        const age = row.age !== undefined ? theme.fg("dim", row.age) : "";
        const room = Math.max(4, width - 4 - visibleWidth(age) - visibleWidth(arrow));
        const label = truncateToWidth(row.label, room);
        const gap = Math.max(1, width - 2 - visibleWidth(label) - visibleWidth(arrow) - visibleWidth(age));
        return `${label}${arrow}${" ".repeat(gap)}${age}`;
      }
      default:
        throw new Error(`unknown row: ${JSON.stringify(row satisfies never)}`);
    }
  }

  render(width: number): string[] {
    const theme = this.theme();
    const choice = this.choice;
    const rows = choice.rows();
    const room = Math.max(3, this.height() - HEAD);
    if (choice.selected < this.top) {
      this.top = choice.selected;
    } else if (choice.selected >= this.top + room) {
      this.top = choice.selected - room + 1;
    } else {
      // in sight
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - room)));
    const filter = choice.filter !== "" ? `${theme.fg("muted", "filter ")}${choice.filter}${theme.fg("accent", "▏")}` : theme.fg("dim", "type to filter");
    const head = [theme.fg("accent", theme.bold(` ${choice.title()}`)), ` ${filter}${choice.loading() ? theme.fg("dim", "  loading…") : ""}`, ""];
    const shown = rows.slice(this.top, this.top + room);
    this.lineRows = [undefined, undefined, undefined, ...shown.map((_, index) => this.top + index)];
    const lines = shown.map((row, index) => {
      const selected = this.top + index === choice.selected;
      const line = ` ${this.rowText(row, width - 1)}`;
      const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
      return selected ? theme.bg("selectedBg", truncateToWidth(padded, width)) : truncateToWidth(padded, width);
    });
    return [...head, ...lines, ...(rows.length === 1 && choice.filter !== "" ? [theme.fg("dim", "  no folder matches")] : [])];
  }

  handleInput(data: string): void {
    const key = keyOf(data);
    if (key !== undefined) {
      void this.choice.key(key).catch(this.failed);
    } else {
      // a key the choice does not use
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const index = this.lineRows[event.y];
    if (index === undefined) {
      return undefined;
    } else if (event.type === "move") {
      const changed = this.choice.selected !== index;
      this.choice.selected = index;
      return { handled: true, render: changed };
    } else if (event.type === "click" && event.button === "left") {
      // the `›` at the end of the label opens; elsewhere the row is chosen
      const row = this.choice.rows()[index];
      const label = row?.kind === "dir" ? visibleWidth(` ${truncateToWidth(row.label, event.width)}`) : -1;
      const onArrow = row?.kind === "dir" && row.hasChildren && event.x >= label && event.x <= label + 2;
      void (onArrow ? this.choice.open(index) : this.choice.choose(index)).catch(this.failed);
      return { handled: true, render: true };
    } else if (event.type === "press") {
      return { handled: true }; // the click comes on release
    } else {
      return undefined;
    }
  }
}
