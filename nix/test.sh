#!/usr/bin/env bash
# Tests of the extension against a built bundle (CI and local):
#   nix/test.sh [bundle-dir]     (default: ./result)
# The unit tests need node and import the extension's npm dependencies
# through the checkout's node_modules, pointed at the bundle's as pi-dev does;
# the server tests drive the bundle's language servers on the fixtures in
# lsp/testdata and need git, go and cargo in PATH (the projects' toolchains
# are never part of the bundle). CI:
#   nix shell nixpkgs#nodejs nixpkgs#git nixpkgs#go nixpkgs#cargo nixpkgs#rustc --command nix/test.sh result
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
BUNDLE="$(readlink -f "${1:-result}")"
export HARNESS_MANIFEST="$BUNDLE/share/harness/manifest.json"
[[ -f "$HARNESS_MANIFEST" ]] || { echo "no manifest at $HARNESS_MANIFEST" >&2; exit 1; }
for tool in node git go cargo; do
  command -v "$tool" >/dev/null || { echo "test: $tool is not in PATH" >&2; exit 1; }
done

# The bundle's node_modules: the parent of the pi package's scope directory.
NODE_MODULES="$(dirname "$(dirname "$(node -p 'require(process.argv[1]).packages.pi' "$HARNESS_MANIFEST")")")"
if [[ -L "$ROOT/node_modules" || ! -e "$ROOT/node_modules" ]]; then
  ln -sfn "$NODE_MODULES" "$ROOT/node_modules"
else
  echo "test: $ROOT/node_modules is not a symlink; remove it so the tests use the bundle's node_modules" >&2
  exit 1
fi

cd "$ROOT"
node --test tool_project_tree.test.ts
node --test gate.test.ts
node --test lsp/test/unit.test.ts
node --test --test-concurrency=1 lsp/test/servers.test.ts
