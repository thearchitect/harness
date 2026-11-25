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
