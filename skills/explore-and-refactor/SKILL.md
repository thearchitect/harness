---
name: explore-and-refactor
description: Deep code exploration and semantic refactoring with codegraph and language servers. Load when planning a change that touches existing code, or before renaming, moving, or mass-editing symbols and files.
---

# Explore and refactor

## What each source knows
- `mcp__codegraph__codegraph_explore` — fast: source of the related symbols plus the call paths among them. A heuristic graph: it can miss interface dispatch, reflection and dynamic calls.
- codegraph `impact` / `callers` / `callees` / `search` / `node` (codemode, `mcp__codegraph__*`) — cheap fan-out over many symbols.
- `mcp__lsp__*` (codemode; agent-lsp over gopls and typescript-language-server) — type-resolved truth: `find_references`, `go_to_implementation`, `find_callers`, `type_hierarchy`, `blast_radius`, `explore_symbol`, `get_diagnostics`. Use it when completeness matters. Call `start_lsp` with the repository root (the directory with `go.work` / `go.mod` / `tsconfig.json`) once per session before anything else. Positions are 1-based.
- `rg` — strings, configs, proto, SQL, templates: anything the code indexes do not cover.

## Exploring with codemode
When a change touches several symbols, gather their impact, callers, references and implementations in one codemode script and return a condensed summary instead of making many single calls. `describeNamespace("lsp")` / `describeNamespace("codegraph")` list the tools.

## Easy to miss
- Implementations of an interface you change: ask for them explicitly.
- Code that already does what you are about to write: search by name and by meaning before adding new code.
- Pre-existing errors: take a diagnostics baseline before editing, so new errors stand out.

## Changing code
- Rename a symbol (Go/TS): `prepare_rename` → `rename_symbol` (returns the edit) → `apply_edit`. Renaming a Go package also moves its directory.
- Check a multi-step edit before writing: `simulate_chain`, or `safe_apply_edit` (applies only if no new diagnostics appear).
- Move or rename TS files, move declarations: `mcp__ts_refactor__file_operations` / `refactoring` with `preview: true` first. Batch moves are not transactional.
- Move Go code between packages: no reliable tool. Edit by hand, then check diagnostics.
- After any MCP-driven write: review `git diff`, then build and test with the project's own commands.
