// The change gate's rules: what a mode does with a file change, by how far the change reaches.
// Scratch space (/tmp, the session workspace) is free in every mode; PLAN refuses everything
// else; BUILD asks the operator; SIMPLE writes the current directory freely and asks for the rest.
// Madness lets everything through before these rules apply. An ask is an Interaction `gate`: it
// stays open until a client answers, whether or not one is connected now.

import type { RunMode } from "#protocol/state.ts";

/** How far a change reaches: scratch space only, the current directory, or anywhere else. */
export type ChangeReach = "scratch" | "cwd" | "outside";

export type ChangeReview = "allow" | "refuse" | "ask";

export function changeReview(mode: RunMode, reach: ChangeReach): ChangeReview {
  if (reach === "scratch") {
    return "allow";
  } else {
    switch (mode) {
      case "plan":
        return "refuse";
      case "build":
        return "ask";
      case "simple":
        return reach === "cwd" ? "allow" : "ask";
      default:
        throw new Error(`unknown mode: ${String(mode satisfies never)}`);
    }
  }
}

export const GATE_TITLE = "Allow file change?";

/** Lines of the change shown in the gate: the first names the tool and subject, the rest list files. */
export const GATE_DETAIL_LINES = 14;

export function clipDetail(lines: readonly string[]): string[] {
  if (lines.length > GATE_DETAIL_LINES) {
    return [...lines.slice(0, GATE_DETAIL_LINES - 1), `… ${lines.length - GATE_DETAIL_LINES + 1} more`];
  } else {
    return [...lines];
  }
}
