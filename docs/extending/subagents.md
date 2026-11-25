# Subagents

A subagent works on a brief in its own context and returns a handover block. Only the model starts
one, with the `subagent` tool, and only when the operator asks for it or the active-mode selector
names an implementer (the prompt's rule; there is no way to start one from the UI).

## Profiles

```
<source>/subagents/<name>/
  SUBAGENT.md   # frontmatter: the profile; body: the role (the subagent's own instructions)
  SKILL.md      # the briefing the calling model reads before it delegates (skill subagent-<name>)
```

```yaml
---
name: explorer
description: Surveys a codebase and reports its structure; changes nothing
engine: harness            # harness | claude
model: openai-codex/sol:medium   # a model reference (extending/models.md); the engine's default when absent
mode: plan                 # plan | build | simple | inherit (the caller's mode)
tools: { allow: [read, "lsp_*"], deny: [lsp_refactor] }   # names and masks; ctx_* never
background: false          # the default of a call
notify: wake               # what a background run's end does: wake | queue | none
subagents: []              # profiles it may call itself (two levels at most)
---
```

Sources, the first one with a name wins: the project's `.harness/subagents/` (trusted projects
only), `~/.harness/subagents/`, the bundle's (`packages/extension/src/subagents/bundled/`:
`builder`, `explorer`). A profile with an error is left out and the session says why. Changes
apply to sessions started after them.

`SKILL.md` is a skill as pi documents it ([skills.md](../../pi/coding-agent/docs/skills.md)); its
description starts with "Only on the operator's explicit request" so the model never takes it as
an invitation.

## Engines

- **harness**: a child agent on the same node — a pi session with harness, the profile's role as
  a prompt section, its tools (declared and enforced), its mode and model. Its interactions reach
  the operator signed with its name; the TUI shows its session when its row is selected, and the
  editor steers it.
- **claude**: the user's own Claude Code (`claude` on PATH, logged in with a Claude subscription,
  at least the version in `engines/claude/launch.ts`), run headless. Its file changes pass
  harness's authorization; harness's tools reach it over MCP as `mcp__harness__<name>`; a wait for
  its limit asks the operator (wait, stop and continue in harness, stop the run); its background
  commands are tasks of the session. No API key or secret of the session reaches it.

## Calls

`subagent { agent, task, continue?, session?, background? }`. `continue` resumes the profile's last
session, `session` a named one. A background call returns at once; its handover block arrives as a
message by the profile's `notify`, and it outlives the caller's agent: when the session opens
again, a finished one reports, a running one is followed again. `/-` stops a running call.
