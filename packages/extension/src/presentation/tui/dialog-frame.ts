// The one frame of every dialog in the editor's place (a question, an edit to approve, a login, a
// secret, a choice, a list, /hub, an extension's component): a line in the theme's `border` color
// above, the dialog's title on it, and one below; nothing on the sides, so what is in it copies
// without padding. The dialog itself takes the focus and the keys; the mouse reaches it under the
// top line. Components of pi and of extensions keep their own lines inside.

import { Container, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

class FrameLine implements Component {
  private readonly draw: (width: number) => string;

  constructor(draw: (width: number) => string) {
    this.draw = draw;
  }

  invalidate(): void {
    // drawn from the theme and the title each time
  }

  render(width: number): string[] {
    return [this.draw(width)];
  }
}

/** The top line: `── title ───…` (the title cut to the width). */
export function frameTop(theme: Theme, width: number, title: string): string {
  if (title === "") {
    return theme.fg("border", "─".repeat(width));
  } else {
    const label = truncateToWidth(` ${title} `, Math.max(0, width - 2), "…");
    return theme.fg("border", "──") + theme.fg("accent", theme.bold(label)) + theme.fg("border", "─".repeat(Math.max(0, width - 2 - visibleWidth(label))));
  }
}

export class DialogFrame extends Container {
  readonly dialog: Component;

  constructor(theme: () => Theme, title: () => string, dialog: Component) {
    super();
    this.dialog = dialog;
    this.addChild(new FrameLine((width) => frameTop(theme(), width, title())));
    this.addChild(dialog);
    this.addChild(new FrameLine((width) => theme().fg("border", "─".repeat(width))));
  }
}
