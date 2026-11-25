---
name: subagent-explorer
description: Only on the operator's explicit request — how to brief the explorer subagent, which surveys a codebase and reports its structure, contracts and conventions without changing anything.
---

# Briefing the explorer

Call `subagent { agent: "explorer", instruction }` only when the operator asked for it in this
conversation. The explorer sees nothing of the conversation: the instruction is all it knows (pass
`plan: "<path>"` too when a survey serves an agreed plan).

Write the instruction so it stands alone:

- **Scope**: the directories, packages or subsystems to survey, and what to leave out.
- **Questions**: the concrete things you need to know (how X reaches Y, where Z is decided, which
  contracts a change of W touches).
- **Depth**: an overview, or a deep reading of the named parts.

It answers with a fixed report — purpose, structure, contracts and entry points, data, build and
tests, conventions, answers to your questions — with paths and line numbers. Treat it as a
colleague's notes: check what your decision rests on in the code before you act on it.

To ask a follow-up in the same context: `subagent { agent: "explorer", continue: true, instruction }`.
