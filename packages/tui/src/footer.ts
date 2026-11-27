// The footer of the active session: where it runs, its model and thinking, how full its context is,
// what it cost; then the gate line (madness, simple) and the session id.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentModel } from "#client/model/agent-model.ts";
import { formatCost } from "#extension/presentation/modes.ts";

export class Footer implements Component {
  model: AgentModel | undefined;
  hub = "";
  private readonly theme: () => Theme;

  constructor(theme: () => Theme) {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme();
    const model = this.model;
    if (model?.session === undefined) {
      return [theme.fg("dim", truncateToWidth(" no session — Ctrl+T new · Ctrl+O open", width))];
    } else {
      const session = model.session;
      const home = process.env.HOME ?? "";
      const cwd = home !== "" && session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd;
      const left = `${this.hub}:${cwd}`;
      const context = session.usage.contextPercent !== undefined ? `${Math.round(session.usage.contextPercent)}%` : "?%";
      const right = [
        model.state.model !== undefined
          ? `${model.state.model.ref} → ${model.state.model.resolved.split("/").slice(1).join("/")}`
          : session.model !== undefined
            ? `${session.model.provider}/${session.model.id}`
            : "no model",
        session.thinkingLevel !== "off" ? session.thinkingLevel : undefined,
        `ctx ${context}`,
        formatCost(session.usage.costUsd),
      ]
        .filter((part) => part !== undefined)
        .join(" · ");
      const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
      const first = theme.fg("dim", truncateToWidth(` ${left}${" ".repeat(gap)}${right} `, width));

      const state = model.state;
      const simple = state.variant === "simple" ? `${theme.fg("success", "simple")} ` : "";
      const gate = state.madness ? theme.fg("error", theme.bold("this is madness")) : theme.fg("dim", "you shall not pass");
      const implementer = state.implementer !== "self" ? ` ${theme.fg("dim", "✻")} ${theme.fg("accent", `implementer ${state.implementer}`)}` : "";
      const second = truncateToWidth(` ${simple}${theme.fg("dim", "✻")} ${gate}${implementer} ${theme.fg("dim", `✻ session ${session.sessionId}`)}`, width);
      return [first, second];
    }
  }
}
