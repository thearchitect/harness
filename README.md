# harness

Personal pi workflow, distributed as a Nix bundle: the pinned `pi` with the
harness extension, the bundled pi packages and the pinned MCP tools.

## Install

Linux / macOS (installs Nix first if needed, after asking):

```bash
curl -fsSL https://raw.githubusercontent.com/thearchitect/harness/master/install.sh | bash
```

NixOS / home-manager: the flake input, the package and the binary cache
(without the cache Nix builds the bundle locally):

```nix
inputs.harness.url = "github:thearchitect/harness";
home.packages = [ inputs.harness.packages.${pkgs.stdenv.hostPlatform.system}.default ];
nix.settings.extra-substituters = [ "https://github.com/thearchitect/harness/releases/download/nix-cache" ];
nix.settings.extra-trusted-public-keys = [ "harness-1:YE1emDZFHptBwqvSGZIoVkGgCUwvCrBxoMFA+zps0Dg=" ];
```

Upgrade: rerun the script, or `nix flake update harness` and rebuild. Verify:
`pi --version`; inside pi, `/deps`. Host settings: `HARNESS_BROWSER` (browser
executable for playwright), `HARNESS_BROWSER_USER_DATA_DIR` (its profile for
chromium-devtools). Details and after-install checks: `install/SKILL.md`.

## Layout

- `index.ts` — the extension: PLAN/BUILD modes, mutation gates (one review per change set, shared by `write`/`edit` and the code tools), `/-`, sequential `write`/`edit`/`bash` (a batch containing one runs in order, so dependent calls see its effect), system prompt per run, UI
- `lsp/` — code intelligence: a facade over the bundle's language servers (see below)
- `prompt.ts` — the system prompt: assembles it from `prompt.yaml`, checks the final prompt and codegraph's tool name
- `prompt.yaml` — every system prompt text: `preamble`, `sections` (`mode_policies`, `engineering_principles`, `code_exploration`, `pi_docs`), `guidelines` (bullets in `<rules>`, in order)
- `skills/<name>/SKILL.md` — on-demand skills the model loads itself: `web-research`
- `install/SKILL.md` — the install/upgrade skill
- `deps.ts` — the bundle: manifest, bundled MCP servers, the language servers of `lsp/`, the `/deps` report, the double-load guard (registered by `index.ts`)
- `workarounds.ts` — temporary compensations for upstream gaps, each with its removal condition (called by `index.ts` at `// WORKAROUND Wn`)
- `nix/` — the bundle: `package.nix` (launchers, extension fileset, manifest), `npm/` (pi, pi packages, npm MCP servers and TypeScript from one lockfile), `sources.json`, `update.sh`, `smoke.sh`, `lsp-test.sh`, CI tests
- `TODO.md` — waiting on upstream

Where a text goes: always in the system prompt → `prompt.yaml`; loaded on
demand → `skills/`.

## System prompt

The harness owns the whole system prompt. It sets pi's `customPrompt` (the
documented `SYSTEM.md` mechanism), so pi's built-in preamble, `<tools>`,
`<rules>` and `<docs>` never appear; `prompt.ts` renders the preamble,
`<tools>`, `<rules>` (guidelines of the declared tools, then `prompt.yaml`
`guidelines`, then other extensions' `promptGuidelines`) and the `prompt.yaml`
sections. pi still renders `<addendum>` (`APPEND_SYSTEM.md`),
`<project_context>`, `<skills>` and `<cwd>`; other extensions add their own
sections. A `SYSTEM.md` is appended after the harness preamble, with a notice.

Limits of pi's extension API: `<tools>`/`<rules>` are rendered once per run (a
tool activated mid-run is declared at once and listed from the next run), and
`promptGuidelines` added by `before_agent_start` handlers that run after the
harness are not rendered — the launcher loads the harness first, and today
every other guideline comes from tool definitions. Every run checks the final
prompt: if it does not open with the harness preamble or contains pi's
built-in prompt, the harness reports an error once per session.

## Code intelligence

`lsp/` drives the bundle's language servers itself — TypeScript 7
(`tsc --lsp`, for TypeScript and JavaScript), gopls and rust-analyzer — and
gives the model one set of tools over them: `lsp_definition`,
`lsp_type_definition`, `lsp_implementations`, `lsp_references`, `lsp_hover`,
`lsp_symbols`, `lsp_call_hierarchy`, `lsp_type_hierarchy`, `lsp_diagnostics`,
`lsp_code_actions`, `lsp_workspace` (read-only, codemode namespace `lsp`) and
`lsp_rename`, `move_file`, `lsp_apply_code_action` (change files, called
directly). A symbol is addressed by `{ file, line, name }`.

- **Whole repository.** The workspace is the git repository of the session
  (the superproject of a submodule). TypeScript: every `tsconfig.json`/
  `jsconfig.json` and everything reachable through `references`, held open
  through the server's API session, plus every source file outside them.
  Go: one generated go.work with the repository's go.work modules, the local
  targets of their `replace` directives and every go.mod of the tree, and the
  union of user-defined build tags. Rust: every Cargo workspace
  (`linkedProjects`), all features. `lsp_workspace` and `/lsp` show the
  coverage and every exclusion.
- **Fresh or failing.** Before each request the servers hear about every file
  created, changed or deleted on disk since the previous one (stamps of the
  git file list, not watchers), the workspace model is updated, and the server
  must be ready (rust-analyzer: quiescent). Anything that fails is an error,
  never a partial answer.
- **Changes all or nothing.** A server's edit is replayed on a virtual file
  system, reviewed once (PLAN refuses, BUILD asks, `/madness` passes), checked
  against the files the server saw, written atomically with rollback, and
  returned as a diff.
- **Lifecycle.** A server starts on first use and stops with the session
  (`session_shutdown`: reload, `/new`, `/resume`, exit), or is killed with its
  process group if pi dies; a crashed server restarts on the next request (three
  crashes in two minutes need `/lsp restart`). The projects' toolchains (`go`,
  `cargo`) come from `PATH`.

## Development

```bash
export HARNESS_DEV_DIR=~/src/harness   # default: the current directory
pi-dev                 # the installed bundle with harness from the checkout; /reload after edits
nix build              # the bundle as users get it
nix/smoke.sh result    # smoke tests of the built bundle
nix/lsp-test.sh result # lsp/ unit tests and tests against the bundle's language servers (needs node, git, go, cargo)
nix/update.sh          # bump every pin (what CI does on a schedule)
```

Keep the checkout outside `~/.pi/agent/extensions/` (pi would load a second
copy). No build step: pi loads `index.ts` through jiti. New files must be git
tracked and listed in the extension fileset of `nix/package.nix` to reach the
bundle; `/reload` does not pick up a changed `prompt.yaml` or skill from an
installed bundle — rebuild and reinstall. Never edit `nix/npm/package-lock.json`
or `nix/sources.json` by hand. Push to `master` → CI checks, builds and
publishes the cache.

## License

[MIT](LICENSE)
