---
name: subagent-builder
description: Only on the operator's explicit request, or when the active-mode selector names the builder as implementer — how to hand an agreed plan to the builder subagent (Claude Code) and review its work.
---

# Handing work to the builder

Call `subagent { agent: "builder", instruction, plan }` only when the operator asked for it in this
conversation, or when the active-mode selector names `implementer="builder"` (then for
implementation only). The builder sees nothing of the conversation: the plan and the instruction
are all it knows.

## The plan

Hand over the agreed plan as a markdown file, `plan: "<path>"`: it goes to the builder whole, and
later calls with the same path send only its changes.

- If the operator had the plan written down, pass that file.
- Otherwise write the plan as agreed in the conversation to `<session workspace>/handover/<name>.md`
  first — the plan itself, adding nothing of your own — and pass that path.

## The instruction

Short, and only about this step:

- which parts of the plan to do now (all of it, or named sections);
- what not to touch;
- which of the plan's checks to run;
- what the report must contain beyond the usual (changed files, checks and their results, what was
  not done and why).

Do not retell the plan's decisions, files or checks in the instruction: they are in the plan.

## After it returns

The result is a handover block: the session, its plan, its state, the files it changed, the checks
it ran, its report, any refused changes. Review it yourself: read `git diff`, run the plan's checks.
For corrections, continue the same session — `subagent { agent: "builder", continue: true,
instruction, plan }` — naming the plan's sections and what you found that differs from them. If the
plan changed meanwhile, pass it again: the builder gets the diff.

If the builder is unavailable (Claude Code missing, not logged in, out of its limit), stop and
tell the operator; do not implement the plan yourself unless the operator says so.
