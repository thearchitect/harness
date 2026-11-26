// A Claude subagent's call (Claude Code's `Task`/`Agent` tool) in a `claude` subagent's transcript:
// collapsed, its description, the count of its steps, the latest step on one line and its result;
// expanded (Ctrl+E), every step — tool calls with their results, text, thinking — shifted right,
// a nested Task's steps under it the same way. The steps come in the result's details
// (claude-transcript.ts), updated while the subagent works.

import { getMarkdownTheme, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { argumentsLine, stepLine, type TaskDetails, type TaskStep } from "#protocol/claude-transcript.ts";

type TaskArgs = { description?: string; subagent_type?: string; prompt?: string };

type ResultLike = { content: { type: string; text?: string }[]; details?: unknown };

/** Lines of a step's result shown when expanded. */
const RESULT_LINES = 8;

function stepsView(steps: TaskStep[], depth: number, theme: Theme): Component {
  const container = new Container();
  const pad = 2 + depth * 2;
  for (const step of steps) {
    switch (step.kind) {
      case "text":
        container.addChild(new Markdown(step.text, pad, 0, getMarkdownTheme()));
        break;
      case "thinking":
        container.addChild(new Text(theme.italic(theme.fg("thinkingText", step.text)), pad, 0));
        break;
      case "tool": {
        const mark = step.result === undefined ? theme.fg("muted", "…") : step.isError === true ? theme.fg("error", "✗") : theme.fg("success", "✓");
        container.addChild(new Text(`${mark} ${theme.fg("toolTitle", theme.bold(step.name))} ${theme.fg("accent", argumentsLine(step.args))}`, pad, 0));
        if (step.steps !== undefined) {
          container.addChild(stepsView(step.steps, depth + 1, theme));
        } else {
          // an ordinary tool: its result's first lines
        }
        const lines = (step.result ?? "").split("\n").filter((line) => line !== "");
        if (lines.length > 0) {
          const shown = lines.slice(0, RESULT_LINES).join("\n");
          const more = lines.length > RESULT_LINES ? `\n… ${lines.length - RESULT_LINES} more lines` : "";
          container.addChild(new Text(theme.fg(step.isError === true ? "error" : "toolOutput", `${shown}${more}`), pad + 2, 0));
        } else {
          // no output (yet)
        }
        break;
      }
      default:
        throw new Error(`unknown step: ${JSON.stringify(step satisfies never)}`);
    }
  }
  return container;
}

export const claudeTaskRenderers = {
  renderCall(args: TaskArgs, theme: Theme): Component {
    return new Text(`${theme.fg("toolTitle", theme.bold("Task "))}${theme.fg("accent", args.subagent_type ?? "")}${args.description !== undefined ? theme.fg("muted", ` · ${args.description}`) : ""}`, 0, 0);
  },

  renderResult(result: ResultLike, options: ToolRenderResultOptions, theme: Theme, context: { isError: boolean }): Component {
    const details = result.details as TaskDetails | undefined;
    const steps = details?.steps ?? [];
    const text = result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
    const latest = steps.at(-1);
    const container = new Container();
    container.addChild(
      new Text(
        theme.fg("muted", `${steps.length} steps${details?.running === true ? " · working" : ""}${latest !== undefined && !options.expanded ? ` · ${stepLine(latest)}` : ""}`),
        0,
        0,
      ),
    );
    if (options.expanded) {
      container.addChild(stepsView(steps, 0, theme));
    } else {
      // collapsed: the count and the latest step
    }
    if (text === "" || (options.expanded && latest?.kind === "text" && latest.text.trim() === text.trim())) {
      // still working, or the last step said it already
    } else if (context.isError) {
      container.addChild(new Text(theme.fg("error", text), 0, 0));
    } else {
      container.addChild(new Markdown(options.expanded ? text : text.split("\n").slice(0, 3).join("\n"), 0, 0, getMarkdownTheme()));
    }
    return container;
  },
};
