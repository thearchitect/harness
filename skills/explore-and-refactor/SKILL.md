---
name: explore-and-refactor
description: Investigate existing code, behavior, architecture and change impact through project structure, data models and API contracts. Load for nontrivial code questions, debugging, planning and refactoring.
---

# Explore and refactor

Use project structure and shared data/contracts as the navigation backbone, not broad feature-keyword searches. DAO, DTO and API are roles: find their equivalents in each project.

**Waves in codemode:** traverse in a few dependent waves. A wave is every read-only lookup whose inputs are already known — `codegraph_explore`, LSP queries, `rg`/`ls` through `tools.bash`, `read` — typically 3–8 calls. Run a wave as one `codemode` script with `Promise.allSettled` and print only the findings, keeping output within the script's budget (10k tokens by default): filter or aggregate in the script, or split the wave by subject. Use a direct call for a single lookup, and direct `bash` for builds, tests, git and other commands with effects. Do not run `start_lsp` or other workspace switches concurrently.

```js
const [graph, refs, hits] = await Promise.allSettled([
  tools.mcp__codegraph__codegraph_explore({ query: "Order OrderDTO createOrder", projectPath: "/abs/root" }),
  tools.mcp__lsp__find_references({ file_path: "/abs/root/order.go", position_pattern: "type @@Order@@ struct" }),
  tools.bash({ command: "rg -n 'OrderDTO' --type go" }),
]);
```

1. **Map the structure:** identify modules, workspace/build roots, data definitions, contracts, API entry points and composition/registration sites.
2. **Find the data anchors:** translate the question into domain entities, persisted structures, types and specific fields; inspect their definitions and related types.
3. **Connect the contracts:** find corresponding DTO/messages, converters and API methods; follow both sides of transport boundaries, including generated code back to its source contract.
4. **Expand usages:** use LSP references/implementations on the relevant types, fields and methods to find readers, writers, validation, authorization and consumers across modules—not just the first matching feature.
5. **Trace the relevant flows:** use codegraph callers/callees/impact and source to connect those usages to entry points, effects and actual registration. Inspect alternative consumers or inherited conditions that can change the answer.

**Tool schemas:** discover them inside codemode with `describeTool(exactName)`, `describeNamespace(server)` or `searchTools(query, { namespace })`—without activating tools. Return concise findings with file/symbol locations and errors/truncation; fetch exact source only for missing details.
**Codegraph:** start indexed structural lookup with `mcp__codegraph__codegraph_explore`; narrow subsequent graph queries by discovered symbols and paths. Its lexical matches and heuristic edges are navigation aids, not an exhaustive result.
**LSP:** initialize the correct root/language with `start_lsp` before semantic queries; use `find_references`, `go_to_implementation` and call/type hierarchy where supported; summary tools may omit usages.
**Fallback/details:** use file listings, `rg` and `read` for structure, string keys, configuration, serialization, unsupported languages or missing graph links. Reuse fresh source already returned. Stop when the relevant paths answer the question; report a concrete gap rather than expanding unrelated branches.
**Refactoring:** check affected references/contracts and existing mechanisms before changes; use semantic previews where supported, obey mutation/approval rules, review the diff and run focused project-native checks. Diagnostics alone do not establish behavioral correctness.
