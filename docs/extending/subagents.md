# Subagents

A subagent works on an instruction — with the agreed plan handed over whole, when there is one — in
its own context and returns a handover block. Only the model starts
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

- **harness**: a child agent on the same hub — a pi session with harness, the profile's role as
  a prompt section, its tools (declared and enforced), its mode and model. Its interactions reach
  the operator signed with its name; the TUI shows its session when its row is selected, and the
  editor steers it.
- **claude**: the user's own Claude Code (`claude` on PATH, logged in with a Claude subscription,
  at least the version in `engines/claude/launch.ts`), run headless. Its file changes pass
  harness's authorization; harness's tools reach it over MCP as `mcp__harness__<name>` (all the
  profile allows that tools may call — not `codemode`, `lsp_refactor` or `ask_user`, which only
  harness's own models call — except `read`, `edit` and `write`, which Claude has natively; the tools
  of harness's MCP servers as `mcp__harness__mcp__<server>__<tool>`); a wait for its limit asks the operator (wait, stop and continue
  in harness, stop the run); its background commands are tasks of the session. No API key or secret
  of the session reaches it.

  Its system prompt is appended to Claude Code's own and assembled from the same parts as harness's
  (`claudeSystemPrompt` in `core/prompt.ts`, the `claude` block of `core/prompt.yaml`): the role,
  the calling session's project context and skills, harness's rules and its tools' with the names
  Claude calls, the policy of the run's mode, the engineering principles, code exploration,
  harness's documents and MCP servers. Claude loads no instruction files and no auto memory of its
  own (`managed-only`, `autoMemoryEnabled: false` in its `--settings`): what it knows of the project
  is what harness loaded.

  Clients show a `claude` subagent as a session: its stream-json becomes pi's messages
  (`protocol/src/claude-transcript.ts`) drawn by pi's components — markdown, thinking (streamed with
  `--include-partial-messages`), tool calls with their results, `Edit` as pi's `edit` with its diff,
  `mcp__harness__<tool>` by that tool's renderer, the run's end as a banner. A subagent of Claude's
  own (`Task`) shows inside its call: collapsed the count of its steps and the latest, expanded
  (Ctrl+E) every step; its row among the session's tasks opens that call. The stream and the
  messages harness sent are kept in `~/.harness/claude/<session>.jsonl`, so the transcript is there
  after a restart; the HAP requests `harness_subagent_snapshot` and `harness_subagent_entries_before`
  read it, `harness_subagent_entries` carries its changes to the clients attached to the session.

## Calls

`subagent { agent, instruction, plan?, continue?, session?, background? }`. `instruction` says what to
do now; `plan` is the path of the agreed markdown plan (in the project or the session workspace, at
most 256 KB). The first message of a session carries the plan whole after the instruction, in a
`<plan path="…">` block; a later call with the same plan carries only the instruction, or the plan's
changes as a diff (`<plan-update>`) when it changed. The call's row shows the plan's path and, expanded,
the plan; the handover block and the subagent's row name it. `continue` resumes the profile's last
session, `session` a named one. A background call returns at once; its handover block arrives as a
message by the profile's `notify`, and it outlives the caller's agent: when the session opens
again, a finished one reports, a running one is followed again. `/-` stops a running call.
