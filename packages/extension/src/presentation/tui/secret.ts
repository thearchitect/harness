// The `secret` interaction in the TUI: what to enter, where it goes, a masked input. The value is
// checked here (secretValueProblem) before it leaves the client; the agent checks it again.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { secretValueProblem, type SecretAnswer, type SecretPayload } from "#protocol/interactions.ts";

/** A single-line input that never renders its value: one bullet per character. */
export class MaskedSecretInput implements Component, Focusable {
  private readonly input = new Input();
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  constructor() {
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.onEscape = () => this.onEscape?.();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const bullets = "•".repeat([...this.input.getValue()].length);
    return [truncateToWidth(`> ${bullets}${this.focused ? "▏" : ""}`, width)];
  }
}

export class SecretDialog implements Component, Focusable {
  private readonly input = new MaskedSecretInput();
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
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const title = ` secret for the agent: ${this.payload.name} `;
    return [
      theme.fg("accent", "──") + theme.fg("dim", theme.bold(title)) + theme.fg("accent", "─".repeat(Math.max(0, width - title.length - 2))),
      ...wrapTextWithAnsi(this.payload.description, inner).map((line) => ` ${line}`),
      ...wrapTextWithAnsi(
        theme.fg("dim", `Kept in memory for this session only; bash commands get it as $${this.payload.name}, tool results show it masked.`),
        inner,
      ).map((line) => ` ${line}`),
      ...(this.payload.replaces ? [` ${theme.fg("warning", `Replaces the value of $${this.payload.name} given earlier.`)}`] : []),
      ...this.input.render(inner).map((line) => ` ${line}`),
      ...(this.problem !== undefined ? [` ${theme.fg("error", this.problem)}`] : []),
      ` ${theme.fg("dim", "Enter store · Esc cancel")}`,
      theme.fg("accent", "─".repeat(width)),
    ].map((line) => truncateToWidth(line, width));
  }
}
