# Skills

Skills are pi's ([skills.md](../../pi/coding-agent/docs/skills.md)): a directory with `SKILL.md`
whose description the model sees in `<skills>` and whose text it reads when the task matches.

Where harness takes them from, in this order of precedence:

1. The project: `.pi/skills/` of the session's directory (pi's discovery, trusted projects only).
2. The user: `~/.harness/skills/`.
3. The bundle: `packages/extension/src/skills/` (`web-research`, `testing`) and the skills of
   bundled tools (the manifest's `skills`, e.g. cage's).

A new or changed skill is picked up when an agent starts (a new session, or a session opened
again). Check it by asking the model in a new session what skills it sees.
