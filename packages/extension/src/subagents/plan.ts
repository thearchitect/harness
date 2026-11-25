// A subagent's plan (the `plan` parameter of the `subagent` tool): the markdown plan the caller
// agreed with the operator, handed over whole next to a short instruction. The first message of a
// session carries the plan in a <plan path="…"> block; a later one carries only what changed.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPatch } from "diff";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { planBlock, type Plan } from "#protocol/plan.ts";
import { scratchWorkspaceRoot } from "../core/authorize.ts";
import { isInsideRoot } from "../core/paths.ts";

/** The largest plan handed over (it goes whole into the subagent's context). */
export const PLAN_MAX_BYTES = 256 * 1024;

/** Reads the plan at `path` (relative to the session's directory): a markdown file in the project or the session workspace. */
export async function readPlan(ctx: ExtensionContext, path: string): Promise<Plan> {
  const absolute = resolve(ctx.cwd, path);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new Error(`plan ${path}: no such file`);
  }
  const size = (await stat(real)).size;
  if (!real.endsWith(".md")) {
    throw new Error(`plan ${path}: not a markdown file (.md)`);
  } else if (!(await isInsideRoot(real, ctx.cwd, ctx.cwd)) && !(await isInsideRoot(real, ctx.cwd, await scratchWorkspaceRoot(ctx)))) {
    throw new Error(`plan ${path}: outside the project (${ctx.cwd}) and the session workspace`);
  } else if (size > PLAN_MAX_BYTES) {
    throw new Error(`plan ${path}: ${size} bytes, more than ${PLAN_MAX_BYTES}`);
  } else {
    return { path: absolute, text: await readFile(real, "utf8") };
  }
}

/**
 * The subagent's next message: the instruction, and the plan as the subagent needs it — whole when
 * it has not seen it (a new session, another plan, or an earlier one unknown), the changes when it
 * changed, nothing more when it is the same.
 */
export function planMessage(instruction: string, plan: Plan | undefined, previous: Plan | undefined): string {
  if (plan === undefined) {
    return instruction;
  } else if (previous === undefined || previous.path !== plan.path) {
    return `${instruction}\n\n${planBlock(plan)}`;
  } else if (previous.text === plan.text) {
    return instruction;
  } else {
    const patch = createPatch(plan.path, previous.text, plan.text, "", "", { context: 3 });
    return `${instruction}\n\n<plan-update path="${plan.path}">\nThe plan changed since your last instruction:\n\n\`\`\`diff\n${patch.trimEnd()}\n\`\`\`\n</plan-update>`;
  }
}
