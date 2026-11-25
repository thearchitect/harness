// harness's rules for Claude Code's own tools (plan 12.6): file changes go through the same
// authorization as harness's own write/edit (PLAN refuses, BUILD asks the operator, SIMPLE allows
// the working directory, madness allows all); harness's MCP tools are gated inside harness; every
// other tool is allowed (Bash: its command is remembered for background tasks by the stream).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClaudeHookInput } from "#protocol/claude.ts";
import type { Authorize } from "../../../core/authorize.ts";
import type { Decision } from "./bridge.ts";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DETAIL_LINES = 40;

/** What the operator sees of a change: the path and a diff of the strings Claude replaces or writes. */
export function changeLines(tool: string, input: Record<string, unknown>): string[] {
  const lines = (prefix: string, text: unknown): string[] => (typeof text === "string" ? text.split("\n").map((line) => `${prefix} ${line}`) : []);
  switch (tool) {
    case "Edit":
      return [...lines("-", input.old_string), ...lines("+", input.new_string)].slice(0, DETAIL_LINES);
    case "MultiEdit":
      return ((input.edits as { old_string?: unknown; new_string?: unknown }[] | undefined) ?? []).flatMap((edit) => [...lines("-", edit.old_string), ...lines("+", edit.new_string)]).slice(0, DETAIL_LINES);
    case "Write":
      return lines("+", input.content).slice(0, DETAIL_LINES);
    case "NotebookEdit":
      return lines("+", input.new_source).slice(0, DETAIL_LINES);
    default:
      return [];
  }
}

export type PolicyDeps = {
  authorize: Authorize;
  ctx: ExtensionContext;
  toolCallId: string;
  profile: string;
  /** The operator chose Stop: Claude and the caller's run end. */
  stop(): void;
  /** The operator approved with a comment: it reaches Claude as a message. */
  comment(text: string): void;
};

export async function decide(input: ClaudeHookInput, deps: PolicyDeps): Promise<Decision> {
  const tool = input.tool_name;
  if (tool.startsWith("mcp__harness__")) {
    return { behavior: "allow" }; // harness's tools pass harness's own gates when they run
  } else if (FILE_TOOLS.has(tool)) {
    const path = input.tool_input.file_path ?? input.tool_input.notebook_path;
    if (typeof path !== "string" || path === "") {
      return { behavior: "deny", reason: `${tool} without a file path` };
    } else {
      const decision = await deps.authorize(deps.ctx, {
        tool: tool === "Write" ? "write" : "edit",
        toolCallId: `${deps.toolCallId}/${input.tool_use_id ?? tool}`,
        paths: [path],
        lines: [`${tool}: ${path}`, ...changeLines(tool, input.tool_input)],
        by: deps.profile,
      });
      switch (decision.kind) {
        case "allowed":
          if (decision.comment !== undefined) {
            deps.comment(decision.comment);
          } else {
            // approved without a comment
          }
          return { behavior: "allow" };
        case "blocked":
          if (decision.terminate) {
            deps.stop();
          } else {
            // a correction: Claude continues with the reason
          }
          return { behavior: "deny", reason: decision.reason };
        default:
          throw new Error(`unknown change decision: ${JSON.stringify(decision satisfies never)}`);
      }
    }
  } else {
    return { behavior: "allow" };
  }
}
