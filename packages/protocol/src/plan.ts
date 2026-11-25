// How a subagent's plan travels in its messages: the instruction, then the whole markdown plan in a
// <plan path="…"> block. Clients split the block off to show the instruction with the plan collapsed.

export type Plan = { path: string; text: string };

export function planBlock(plan: Plan): string {
  return `<plan path="${plan.path}">\n${plan.text.trimEnd()}\n</plan>`;
}

/** A message split back into its instruction and plan block. */
export function splitPlanMessage(text: string): { instruction: string; plan?: Plan } {
  const match = /^([\s\S]*?)\n\n<plan path="([^"]+)">\n([\s\S]*)\n<\/plan>$/.exec(text);
  if (match !== null) {
    return { instruction: match[1] ?? "", plan: { path: match[2] ?? "", text: match[3] ?? "" } };
  } else {
    return { instruction: text };
  }
}
