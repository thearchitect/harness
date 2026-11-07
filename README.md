# harness

Personal pi workflow, distributed as a Nix bundle: the pinned `pi` with the
harness extension, the bundled pi packages and the pinned MCP tools. On PATH:
`pi`, `pi-dev`, `herdr`, `pnpm`, `cage`, `lightpanda`, `playwright-mcp`,
`chrome-devtools-mcp` (the last ones with telemetry off by default). herdr's pi
integration is part of the bundle: do not `herdr integration install pi`
(`/deps` warns about such a copy). `HARNESS_PROFILE=server` runs pi headless
(as the Telegram gateway does): no user-browser MCP servers, no `ask_user`.

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
- `tool_project_tree.ts` — `project_tree`: a project's layout in one call (see below)
- `prompt.ts` — the system prompt: assembles it from `prompt.yaml`, checks the final prompt
- `prompt.yaml` — every system prompt text: `preamble`, `sections` (`mode_policies`, `engineering_principles`, `code_exploration`, `pi_docs`), `guidelines` (bullets in `<rules>`, in order)
- `remote/` — `harness-telegram`, the Telegram gateway of a server deployment (one pi RPC process per topic; see "Remote" below); a separate package (`nix/remote.nix`), not loaded by pi
- `rpc-dialogs.ts` — the write/edit gate as plain select/input dialogs outside the TUI: the contract RPC clients (the Telegram gateway) render natively
- `skills/<name>/SKILL.md` — on-demand skills the model loads itself: `web-research`, `cage`
- `install/SKILL.md` — the install/upgrade skill
- `deps.ts` — the bundle: manifest, bundled MCP servers, the language servers of `lsp/`, the `/deps` report, the double-load guard (registered by `index.ts`)
- `workarounds.ts` — temporary compensations for upstream gaps, each with its removal condition (called by `index.ts` at `// WORKAROUND Wn`)
- `nix/` — the bundle: `package.nix` (launchers, extension fileset, manifest), `npm/` (pi, pi packages, npm MCP servers, TypeScript and the extension's own npm dependencies from one lockfile), `sources.json`, `update.sh`, `smoke.sh`, `test.sh`, CI tests
- `TODO.md` — waiting on upstream

Where a text goes: always in the system prompt → `prompt.yaml`; loaded on
demand → `skills/`. A file that defines tools for the model is named
`tool_<name>.ts`.

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
`lsp_code_actions`, `lsp_workspace` (read-only; declared to the model and
callable from scripts, namespace `lsp`) and `lsp_refactor` (changes files,
called directly). A symbol is addressed by `{ file, line, name }`; paths are
relative to the session's cwd, in arguments and results, like every other
tool's. A file no language server handles is moved as is, with a note to find
its references with `rg`.

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
- **Refactoring.** `lsp_refactor` takes a list of operations — `rename`,
  `move`, `codeAction`, `edit` (exact text) — inline or as a plan file (a JSON
  array in the session workspace, typically written by a codemode script). The
  list is reviewed once (PLAN refuses, BUILD asks, `/madness` passes); the
  operations then run in order, each on the state the previous ones left. Each
  one's edit is replayed on a virtual file system, checked against the files
  the server saw, kept inside the repository and written atomically. A failing
  operation stops the run: the ones before it stay applied and the plan file is
  cut down to the failed one and the rest, to fix and rerun. Renamed symbols
  defined in files that look generated (`linguist-generated`, `Code generated …
  DO NOT EDIT.`, header comments, generator file names) are reported: change
  the source and regenerate afterwards.
- **Lifecycle.** A server starts on first use and stops with the session
  (`session_shutdown`: reload, `/new`, `/resume`, exit), or is killed with its
  process group if pi dies; a crashed server restarts on the next request (three
  crashes in two minutes need `/lsp restart`). The projects' toolchains (`go`,
  `cargo`) come from `PATH`.

## Project tree

`project_tree` gives the model a project's layout in two steps. Without
arguments it returns the whole directory tree as byte-sorted paths, each
directory with the number of files directly in it and the first line of its
`.dirinfo.md` (`src/ (12 files) - HTTP API and its handlers`), plus the files of
the project root (manifests, entry points). Then `path` with `files: true` lists
every file of a subtree the model needs. A directory listed explicitly although
the rules above ignore it (`node_modules/x`) is listed under its own rule
files. It honors `.ignore`, `.gitignore`
and the repository's `info/exclude` like fd and ripgrep (`.gitignore` only
inside git; global git excludes are not read), never lists `.git`, session
workspaces or symlinks, and marks unreadable directories in place.
Project-specific exclusions go into the project's `.ignore`. The `.dirinfo.md`
files are written by people; the model only reads them.

## Remote: Telegram on Fly

harness also runs on a server, used through a Telegram bot: `remote/`
(`harness-telegram`), `lib.mkRemoteImage` (`nix/remote-image.nix`) and the
deployment template `nix flake init -t github:thearchitect/harness#remote`
(its README walks through the setup).

- **Model.** A whitelist of Telegram users (`remote.yaml`); each works under
  a uid of their own in `/data/home/<name>`. Every topic of the private chat
  with the bot is one pi session (`pi --mode rpc --session-id`, profile
  `server`) in a directory picked with one tap.
- **Interaction.** A persistent keyboard of four sections (🔨 Build · ⏹ Stop ·
  🧠 Model · ⚙️ More: thinking, compact, close, logins, secrets, the server
  SSH key) acting on the topic it is pressed in; a section's choices open as a
  panel at the bottom of the topic, never above the screen. A pinned status
  line per topic (directory, model, thinking, next mode, state); a live draft of the run with
  Telegram's native stop; thinking and tool calls in collapsed blocks; a
  banner with duration and cost; 🔨 Build under a plan. Write/edit
  confirmations are buttons and always the last message of the topic; a
  text instead of a button rejects with that text. Writing during a run
  steers it.
- **Machine.** One Fly machine with a volume; the gateway answers the
  webhook and exits when idle, so the machine sleeps until the next message.
- **Secrets.** The image carries only cage ciphertext; the machine's identity
  is its single Fly secret. The bot token and webhook secret stay inside the
  gateway; each pi process gets only its user's variables (the deployment's
  `user-<name>` env and the user's own `~/.cage`), never the gateway's.
  An agent sees its user's secrets and `auth.json` — the boundary is between
  users, not between a user and their agent.

## Development

```bash
export HARNESS_DEV_DIR=~/src/harness   # default: the current directory
pi-dev                 # the installed bundle with harness from the checkout; /reload after edits
nix build              # the bundle as users get it
nix/smoke.sh result    # smoke tests of the built bundle
nix/test.sh result     # unit tests and tests against the bundle's language servers (needs node, git, go, cargo)
nix/update.sh          # bump every pin (what CI does on a schedule)
```

Keep the checkout outside `~/.pi/agent/extensions/` (pi would load a second
copy). No build step: pi loads `index.ts` through jiti. The extension's npm
dependencies come from `nix/npm` and resolve through `node_modules` next to
`index.ts`: a symlink to the bundle's, made by the bundle itself, by `pi-dev`
in the checkout and by `nix/test.sh`. New files must be git
tracked and listed in the extension fileset of `nix/package.nix` to reach the
bundle; `/reload` does not pick up a changed `prompt.yaml` or skill from an
installed bundle — rebuild and reinstall. Never edit `nix/npm/package-lock.json`
or `nix/sources.json` by hand. Push to `master` → CI checks, builds and
publishes the cache.

## License

[MIT](LICENSE)
