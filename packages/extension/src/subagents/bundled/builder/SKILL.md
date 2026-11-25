---
name: subagent-builder
description: Only on the operator's explicit request, or when the active-mode selector names the builder as implementer — how to hand an agreed plan to the builder subagent (Claude Code) and review its work.
---

# Handing work to the builder

Call `subagent { agent: "builder", task }` only when the operator asked for it in this
conversation, or when the active-mode selector names `implementer="builder"` (then for
implementation only). The builder sees nothing of the conversation: the brief is the plan.

## The brief

Hand over the agreed plan whole and self-contained:

- the goal and the decisions taken, with their reasons where they constrain the work;
- every change: files, symbols, data and contracts, with the behavior each gets;
- the checks that prove it, as commands;
- what not to touch.

## After it returns

The result is a handover block: the session, its state, the files it changed, the checks it ran,
its report, any refused changes. Review it yourself: read `git diff`, run the plan's checks. For
corrections, continue the same session — `subagent { agent: "builder", continue: true, task }` —
naming what you found and what changed since it stopped.

If the builder is unavailable (Claude Code missing, not logged in, out of its limit), stop and
tell the operator; do not implement the plan yourself unless the operator says so.
