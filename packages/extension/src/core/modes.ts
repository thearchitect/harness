// Modes of a run. The advanced variant switches PLAN/BUILD per message; the simple variant has
// the single SIMPLE mode. A client names the mode of a prompt explicitly (harness_prompt); a plain
// pi prompt names it the classic way: a leading "!" asks for BUILD.

import type { RunMode, Variant } from "#protocol/state.ts";

/** The mode a message asks for, and its text without the "!" marker. */
export function modeOfText(text: string, variant: Variant): { mode: RunMode; text: string } {
  const marked = text.startsWith("!");
  const stripped = marked ? text.slice(text.startsWith("! ") ? 2 : 1) : text;
  switch (variant) {
    case "simple":
      return { mode: "simple", text: stripped };
    case "advanced":
      return { mode: marked ? "build" : "plan", text: stripped };
    default:
      throw new Error(`unknown variant: ${String(variant satisfies never)}`);
  }
}

/** The mode a client asked for, as the variant allows it: the simple variant has only SIMPLE. */
export function effectiveMode(requested: RunMode, variant: Variant): RunMode {
  switch (variant) {
    case "simple":
      return "simple";
    case "advanced":
      return requested === "simple" ? "build" : requested;
    default:
      throw new Error(`unknown variant: ${String(variant satisfies never)}`);
  }
}

/** The selector message that opens each run: the system prompt applies the named mode policy. */
export function modeSelector(mode: RunMode, implementer: string): string {
  if (implementer !== "self" && mode !== "plan") {
    return `<active-mode mode="${mode}" implementer="${implementer}" />`;
  } else {
    return `<active-mode mode="${mode}" />`;
  }
}

export const MODE_TEXT: Record<RunMode, { chip: string; working: string; finished: string; interrupted: string }> = {
  plan: { chip: "PLAN", working: "Planning...", finished: "planning finished", interrupted: "planning interrupted" },
  build: { chip: "BUILD", working: "Building...", finished: "building finished", interrupted: "building interrupted" },
  simple: { chip: "SIMPLE", working: "Working...", finished: "finished", interrupted: "interrupted" },
};

export function isRunMode(value: unknown): value is RunMode {
  return value === "plan" || value === "build" || value === "simple";
}
