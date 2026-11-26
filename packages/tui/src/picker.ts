// A list in the editor's place (Workbench pickers: models, sessions, the tree, settings, logins): its
// title, the scopes to switch between (the model's Favorites | All, as pi's model selector shows
// them), a filter field, the list, and a hint line naming every key with what it does.
//
// Keys: typing filters, ↑/↓ select, Tab the next scope, Enter chooses (the typed text itself where the
// picker takes one), Esc cancels. The mouse: a click chooses a row, the wheel scrolls.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, Key, matchesKey, SelectList, Text, type Focusable } from "@earendil-works/pi-tui";
import { pickerHints, type Picker } from "#client/workbench/workbench.ts";
import { selectListTheme } from "#extension/presentation/tui/gate.ts";

const VISIBLE = 15;

/** A hint line as pi draws key hints: the key dim, what it does muted. */
export function hintLine(theme: Theme, hints: { key: string; does: string }[]): string {
  return ` ${hints.map((hint) => `${theme.fg("dim", hint.key)} ${theme.fg("muted", hint.does)}`).join(theme.fg("dim", " · "))}`;
}

export class PickerView extends Container implements Focusable {
  private readonly picker: Picker;
  private readonly theme: () => Theme;
  private readonly onScope: () => void;
  private readonly onCancel: () => void;
  private readonly filter = new Input();
  private readonly list: SelectList;
  private focusedState = false;

  constructor(picker: Picker, theme: () => Theme, actions: { scope(): void; cancel(): void }) {
    super();
    this.picker = picker;
    this.theme = theme;
    this.onScope = actions.scope;
    this.onCancel = actions.cancel;
    const t = theme();
    this.list = new SelectList(picker.items, Math.min(VISIBLE, Math.max(1, picker.items.length)), selectListTheme(t));
    this.list.setSelectedIndex(Math.max(0, picker.items.findIndex((item) => item.value === picker.initial)));
    this.list.onSelect = (item) => void picker.choose(item.value);
    this.list.onCancel = () => this.onCancel();

    this.addChild(new Text(t.fg("accent", t.bold(` ${picker.title}`)), 0, 0));
    if (picker.scopes !== undefined && picker.scopes.length > 1) {
      const shown = picker.scope ?? 0;
      const scopes = picker.scopes.map((scope, index) => (index === shown ? t.fg("accent", scope.title) : t.fg("muted", scope.title))).join(t.fg("muted", " | "));
      this.addChild(new Text(` ${t.fg("muted", "Scope: ")}${scopes}`, 0, 0));
    } else {
      // one list
    }
    this.addChild(this.filter);
    this.addChild(this.list);
    this.addChild(new Text(hintLine(t, pickerHints(picker)), 0, 0));
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.filter.focused = value;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (matchesKey(data, Key.tab)) {
      this.onScope();
    } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") || keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
      this.list.handleInput(data);
    } else if (keys.matches(data, "tui.select.confirm")) {
      const typed = this.filter.getValue().trim();
      const item = this.list.getSelectedItem();
      if (item !== null) {
        void this.picker.choose(item.value);
      } else if (this.picker.custom !== undefined && typed !== "") {
        void this.picker.choose(typed);
      } else {
        // nothing to choose
      }
    } else if (keys.matches(data, "tui.select.cancel")) {
      this.onCancel();
    } else {
      this.filter.handleInput(data);
      this.list.setFilter(this.filter.getValue());
    }
  }
}
