#!/usr/bin/env bash
# Tests of code intelligence (lsp/) against a built bundle (CI and local):
#   nix/lsp-test.sh [bundle-dir]     (default: ./result)
# The unit tests need node; the server tests drive the bundle's language
# servers on the fixtures in lsp/testdata and need git, go and cargo in PATH
# (the projects' toolchains are never part of the bundle). CI:
#   nix shell nixpkgs#nodejs nixpkgs#git nixpkgs#go nixpkgs#cargo nixpkgs#rustc --command nix/lsp-test.sh result
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
BUNDLE="$(readlink -f "${1:-result}")"
export HARNESS_MANIFEST="$BUNDLE/share/harness/manifest.json"
[[ -f "$HARNESS_MANIFEST" ]] || { echo "no manifest at $HARNESS_MANIFEST" >&2; exit 1; }
for tool in node git go cargo; do
  command -v "$tool" >/dev/null || { echo "lsp-test: $tool is not in PATH" >&2; exit 1; }
done

cd "$ROOT"
node --test lsp/test/unit.test.ts
node --test --test-concurrency=1 lsp/test/servers.test.ts
