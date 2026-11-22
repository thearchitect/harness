# harness: rules for agents

Before every commit, with the changes staged (`git add`: the flake builds only
git-tracked files), run the local minimum and commit only when it passes:

```bash
nix develop --command sh -c 'nix build && nix/smoke.sh result && nix/test.sh result'
```

`master` is what users install and update to, and CI checks it only after the
push. The unit tests import the checkout, so only the built bundle shows what
users get: a new extension file must be listed in the extension fileset of
`nix/package.nix`.
