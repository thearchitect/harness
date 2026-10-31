# TODO

Waiting on upstream.

- **TypeScript refactorings in TypeScript 7.** The native language server
  (`tsc --lsp`) has no refactorings yet: extract function/constant/variable,
  move to file, infer return type. They left with `mcp-refactor-typescript`
  (tsserver-based, unable to see a whole monorepo). When typescript-go ports
  them (`internal/ls` of microsoft/typescript-go), they arrive as code actions
  (`refactor.*`) through `lsp_code_actions` / `lsp_apply_code_action`; check
  that `lsp_apply_code_action` handles their interactive arguments (move to
  file needs a target file).
