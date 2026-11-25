// This agent as a subagent (plan 12.3): its launch fixes the tools it may use (declared to the model
// and enforced at every call), its role (an extra system prompt section), the mode of its runs
// and its model. Its interactions say which subagent asks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_SUBAGENT_DEPTH, type SubagentLaunch } from "#protocol/state.ts";
import { toolAllowed } from "./registry.ts";

/** The section the role becomes, with the rule on calling subagents (S5 for subagents). */
export function roleSection(launch: SubagentLaunch): string {
  const calls =
    launch.subagents.length > 0 && launch.depth < MAX_SUBAGENT_DEPTH
      ? "\n\nCall a subagent only when the brief explicitly says so."
      : "";
  return `You run as the subagent "${launch.profile}": another model gave you a brief and sees only your final answer; you do not see its conversation.\n\n${launch.role}${calls}`;
}

export function isToolAllowed(launch: SubagentLaunch, name: string): boolean {
  return toolAllowed(name, launch, MAX_SUBAGENT_DEPTH);
}

/** Declares only the launch's tools (other extensions' tools register later: run before each run). */
export function declareTools(pi: ExtensionAPI, launch: SubagentLaunch): void {
  pi.setActiveTools(
    pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => isToolAllowed(launch, name)),
  );
}
