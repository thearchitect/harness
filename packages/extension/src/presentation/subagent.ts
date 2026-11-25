// The `subagent` tool's rows: the call shows the profile, the instruction and the plan's path; the
// result shows the handover block, and expanded (Ctrl+E) the plan the subagent got.

import { getMarkdownTheme, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { Plan } from "#protocol/plan.ts";

type SubagentArgs = { agent?: string; instruction?: string; plan?: string; continue?: boolean; session?: string; background?: boolean };

type ResultLike = { content: { type: string; text?: string }[]; details?: unknown };

export const subagentRenderers = {
  renderCall(args: SubagentArgs, theme: Theme): Component {
    const how = [args.continue === true ? "continue" : undefined, args.session !== undefined ? `session ${args.session}` : undefined, args.background === true ? "background" : undefined].filter(
      (part): part is string => part !== undefined,
    );
    const lines = [
      `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "")}${how.length > 0 ? theme.fg("muted", ` · ${how.join(" · ")}`) : ""}`,
      ...(args.instruction !== undefined && args.instruction !== "" ? [theme.fg("toolOutput", args.instruction)] : []),
      ...(args.plan !== undefined ? [`${theme.fg("muted", "plan: ")}${theme.fg("accent", args.plan)}`] : []),
    ];
    return new Text(lines.join("\n"), 0, 0);
  },

  renderResult(result: ResultLike, options: ToolRenderResultOptions, theme: Theme, context: { isError: boolean }): Component {
    const text = result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
    const plan = (result.details as { plan?: Plan } | undefined)?.plan;
    const container = new Container();
    container.addChild(new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0));
    if (plan !== undefined && options.expanded) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", `plan ${plan.path}:`), 0, 0));
      container.addChild(new Markdown(plan.text, 0, 0, getMarkdownTheme()));
    } else {
      // collapsed, or no plan: the call row names the plan's path
    }
    return container;
  },
};
