# experiments

Not part of the bundle, the build, the tests or the documentation checks.

- `architecture-postulates/` — the postulates, written directly as a skill; load it on demand by
  asking the model to read its `SKILL.md` by path
- `methodology/` — `methodology.yaml` is the source; `bun experiments/methodology/build.ts`
  regenerates `SKILL.md` (committed)
- `telegram/` — history: the Telegram gateway and its Mini App, the remote frontend before the
  harness platform (nodes, hub, the TUI and the app); kept as it was, not maintained
