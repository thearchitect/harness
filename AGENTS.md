# harness: rules for agents

Before every commit, with the changes staged (`git add`: the flake builds only
git-tracked files), run the local minimum and commit only when it passes:

```bash
nix develop --command nix flake check
```

It builds the bundle and runs `nix/check.sh` on it: the type check, the unit
and integration tests, the smoke tests of the built bundle. While working,
`nix/check.sh [test files…]` runs the same from the checkout (its
`node_modules` must point at the bundle's: `harness-dev` sets it).

`master` is what users install and update to, and CI checks it only after the
push. The sources run as TypeScript on node (types stripped, no build step):
a new package directory or source file needs no Nix change; a new npm
dependency goes into `nix/npm/package.json` and its regenerated lock.

## Architecture, UI and UX

- One model, every client: the Workbench and the agent models decide; the TUI
  and the app only draw them, with the same keys, rows and words.
- pi first: pi's components and semantics are used as they are; a deviation is
  written down in the plan's deviations.
- Every control works by keyboard, click and hover; key releases never act.
- Keys: ↑↓ move between rows and leave a field, ← goes back outside a field,
  Enter applies, Esc closes or cancels; typing goes to the step's field at once.
- One single-line input (LineField): a cursor that moves with the arrows, the
  terminal's own cursor as in the chat's editor, a column kept for it at the
  end, no padding.
- Text the operator copies (links, codes, output) has no padding; links are
  clickable and have open and copy actions.
- Things happen where the operator is: links open on the client's machine; a
  browser's callback reaches a remote node through the client.
- Cost does not grow with a session: transcripts are virtual, drawn by visible
  rows, cached per width; sessions load in the background ahead of use, so
  opening one is instant; memory is spent before time.
- State is the node's; a window's view is the device's and survives restarts;
  concurrent writers merge by revision or lock — consistency is predictable.
- Every user-facing behavior has a scenario on the built bundle; prompts and
  tools have golden files.
