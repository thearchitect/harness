// The `secret` interaction in the TUI: what to enter, where it goes, a masked input. The value is
// checked here (secretValueProblem) before it leaves the client; the agent checks it again.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { secretValueProblem, type SecretAnswer, type SecretPayload } from "#protocol/interactions.ts";
import { LineField } from "./line-field.ts";

export class SecretDialog implements Component, Focusable {
  /** The value never drawn: one bullet per character, the cursor among them. */
  private readonly input = new LineField({ prompt: "> ", mask: "•" });
  private problem: string | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly payload: SecretPayload;

  constructor(tui: TUI, theme: Theme, payload: SecretPayload, done: (answer: SecretAnswer) => void) {
    this.tui = tui;
    this.theme = theme;
    this.payload = payload;
    this.input.onSubmit = (value) => {
      const problem = secretValueProblem(value);
      if (problem === undefined) {
        done({ value });
      } else {
        this.problem = problem;
        this.tui.requestRender();
      }
    };
    this.input.onEscape = () => done({ cancelled: true });
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.problem = undefined;
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    // the frame's lines and the title (the secret's name) are the dialogs' frame's; no side padding
    const theme = this.theme;
    return [
      ...wrapTextWithAnsi(this.payload.description, width),
      ...wrapTextWithAnsi(theme.fg("dim", `Kept in memory for this session only; bash commands get it as $${this.payload.name}, tool results show it masked.`), width),
      ...(this.payload.replaces ? [theme.fg("warning", `Replaces the value of $${this.payload.name} given earlier.`)] : []),
      ...this.input.render(width),
      ...(this.problem !== undefined ? [theme.fg("error", this.problem)] : []),
      theme.fg("dim", "Enter store · Esc cancel"),
    ].map((line) => truncateToWidth(line, width));
  }
}
