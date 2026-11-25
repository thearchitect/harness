# Model references

pi selects a model by its exact id ([models.md](../../pi/coding-agent/docs/models.md#select-a-model)).
harness also takes a reference without a version: `provider/<family | id>[:<thinking>]`, e.g.
`anthropic/opus:medium` or `openai-codex/sol`.

How a family resolves (`packages/protocol/src/model-ref.ts`, the same in agents and clients):

1. An exact id of the provider is taken as is.
2. Otherwise the candidates are the provider's models whose id has the family as a separate token
   (separators `-`, `.`, `/`); dated snapshots (`-YYYYMMDD`) are left out.
3. Candidates are grouped by their id without numeric tokens; the group with the fewest tokens wins
   (variants like `claude-opus-fast` stay out). Two such groups make the reference ambiguous.
4. In the group the highest version wins, compared as numbers: `[5,5] > [5] > [4,8]`.

Where references are taken:

- the model list of the TUI (Ctrl+L) offers the catalog's references first (`anthropic/opus →
  claude-opus-5-5`); choosing one makes the session follow it;
- `model` in `~/.harness/harness.json`: the reference new sessions start with (the last one chosen).

A session records the reference (`harness-model-ref` entries). When it opens again the reference
resolves again: if the catalog has a newer model of the family, or the old one is gone, the
session moves to the new one and the transcript says so (`opus: claude-opus-5-5 →
claude-opus-5-6`). Choosing an exact model ends following the reference.
