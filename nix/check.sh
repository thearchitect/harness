#!/usr/bin/env bash
# The checks of the harness sources: the type check, then every unit and
# integration test (node's test runner). Run from a checkout whose
# node_modules points at the bundle's (harness-dev sets it), or by
# `nix flake check` (nix/check.nix) in a copy of the sources.
#
#   nix/check.sh [test files or globs…]   default: every *.test.ts
set -euo pipefail
cd "$(dirname "$0")/.."

node_modules/.bin/tsc -p .
# the app, against its own modules (packages/app/node_modules: harness-dev and nix/check.nix link them)
if [[ -e packages/app/node_modules ]]; then
  node_modules/.bin/tsc -p packages/app/tsconfig.json
else
  echo "nix/check.sh: packages/app/node_modules is missing: the app is not type-checked" >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  tests=("$@")
else
  tests=('packages/**/*.test.ts' 'tests/**/*.test.ts')
fi
node --test --test-concurrency=4 "${tests[@]}"
