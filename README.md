# harness

A multi-session coding agent platform on [pi](https://github.com/earendil-works/pi), distributed as
a Nix bundle. Nodes run agents — pi sessions with the harness extension — as the user who runs
them; a hub links nodes and devices; the full-screen TUI (`harness`) works with sessions on the
local node and on remote ones at once. The documents start at [docs/index.md](docs/index.md).

On PATH: `harness`, `harness-dev`, `pnpm`, `cage`, `lightpanda`, `playwright-mcp`,
`chrome-devtools-mcp` (telemetry off by default), and the runtimes `node`, `npm`, `npx`, `bun`,
`bunx` at a low priority (your own node or bun wins). Agents also have `ffmpeg`, `ffprobe` and
`exiftool` on their PATH, not on yours (bundled tools: see Install). The bundled MCP servers:
`lightpanda` (search and reading), `browser` (a real Chromium through Patchright for logins and
bot checks; Chromium from cache.nixos.org on Linux, Google Chrome from Google on macOS),
`playwright` and `chromium-devtools` (your own browser; registered disabled, enable them in
`/mcp`).

On macOS the bundle also brings Ghostty and a Finder item: right-click a folder → **Harness**
opens a Ghostty window running `harness` in that folder. On PATH: `ghostty`, `harness-open
[DIR...]` (the same from a terminal) and `harness-setup`, which installs the item
(`~/Library/Services/Harness.workflow`). A Ghostty of your own (1.3 or later) wins over the bundled
one; with only the bundled one, `harness-setup` turns its self-update off (Nix updates it).

## Install

Linux / macOS (installs Nix first if needed, after asking):

```bash
curl -fsSL https://raw.githubusercontent.com/thearchitect/harness/master/install.sh | bash
```

NixOS / home-manager: the flake input and the package:

```nix
inputs.harness.url = "github:thearchitect/harness";
home.packages = [ inputs.harness.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

A configuration chooses the mode of each bundled tool with `bundled` (unlisted tools keep their
defaults): `"none"` leaves it out, `"hidden"` puts it on the agents' PATH only (appended, so your
own or a project's version wins), `"path"` also on yours at a low priority.

| tool | executables | default | modes |
|---|---|---|---|
| `node` | `node`, `npm`, `npx` | `path` | `hidden`, `path` |
| `bun` | `bun`, `bunx` | `path` | `hidden`, `path` |
| `ffmpeg` | `ffmpeg`, `ffprobe` (ffmpeg-headless) | `hidden` | `hidden`, `path` |
| `exiftool` | `exiftool` | `hidden` | `hidden`, `path` |
| `go` | `go`, `gofmt` | `none` | `none`, `hidden`, `path` |
| `rust` | `rustc`, `rustdoc`, `cargo`, clippy, rustfmt, `cc`, `c++` (rustc's linker) | `none` | `none`, `hidden`, `path` |

```nix
(inputs.harness.packages.${pkgs.stdenv.hostPlatform.system}.default.override {
  bundled = { go = "path"; rust = "hidden"; ffmpeg = "path"; };
})
```

Nodes as services: [docs/operations/nixos.md](docs/operations/nixos.md); a hub on Fly.io:
[docs/operations/fly.md](docs/operations/fly.md). Upgrade: rerun the script, or `nix flake update
harness` and rebuild. Host settings: `HARNESS_BROWSER` (your own Chrome/Chromium for `browser` and
playwright), `HARNESS_BROWSER_USER_DATA_DIR` (its profile for chromium-devtools), `HARNESS_HOME`
(instead of `~/.harness`).

## Using it

- `harness` opens the TUI in the current directory: tabs of open sessions on the left, the active
  session in the middle, its background tasks and subagents on the right. A message plans; a
  message starting with `!` builds (`/simple`: one mode that decides itself). Ctrl+Enter (or
  Alt+Enter) sends, Ctrl+T opens a new session, Ctrl+O an existing one, Alt+1…9 switches tabs,
  Ctrl+\ opens the harness panel, Ctrl+F searches the transcript, Ctrl+L chooses the model. As in
  pi, Ctrl+C clears the editor and Ctrl+D on an empty editor closes the session's tab (its agent
  keeps running); Ctrl+Q quits.
- Sessions live on their node: closing the TUI leaves a node started as a service (and its
  agents) running; reopening shows everything again. Every client of a user sees the same tabs.
- `harness hub`, `harness remote add`: [docs/operations/nodes.md](docs/operations/nodes.md).
- Provider accounts: `harness auth login` (pi's command on `~/.harness`).

## Code intelligence

The extension drives the bundle's language servers itself — TypeScript 7 (`tsc --lsp`, for
TypeScript and JavaScript), gopls and rust-analyzer — and gives the model one set of tools over
them: `lsp_definition`, `lsp_type_definition`, `lsp_implementations`, `lsp_references`,
`lsp_hover`, `lsp_symbols`, `lsp_call_hierarchy`, `lsp_type_hierarchy`, `lsp_diagnostics`,
`lsp_code_actions`, `lsp_workspace` and `lsp_refactor` (renames, moves, code actions, exact
edits; reviewed once by the gate). The workspace is the git repository of the session: every
TypeScript project, Go module and Cargo workspace in it. Before each request the servers hear
about every file changed on disk; anything that fails is an error, never a partial answer.
Sources: `packages/extension/src/tools/lsp/`.

## Project tree

`project_tree` gives the model a project's layout in two steps: without arguments the whole
directory tree with file counts and the first line of each directory's `.dirinfo.md`, then `path`
with `files: true` for the files of a subtree. It honors `.ignore`, `.gitignore` and the
repository's `info/exclude` like fd and ripgrep.

## Development

```bash
nix develop                         # harness-dev, harness-test, node, the tests' toolchains
harness-dev                         # the bundle running this checkout (restart after edits)
nix/check.sh [test files…]          # type check and tests from the checkout
harness-test [unit|integration|gallery|up …]   # the test harness (docs/extending/testkit.md)
nix develop --command nix flake check          # before every commit (AGENTS.md)
```

The sources run as TypeScript on node (types stripped, no build step). npm dependencies come from
`nix/npm` (never edit its lock by hand); the checkout's `node_modules` is a symlink to the
bundle's. The plan of the platform and its progress: `plans/harness-platform-plan.md`.

## TODO

Deliberately postponed:

- Native push notifications: APNs (iOS) and FCM (Android) through our push relay (`harness relay`
  role) deployed on Fly; hubs send through it with per-device handles bound to the hub key.
- End-to-end encrypted push payloads: the hub encrypts for the device key, the iOS Notification
  Service Extension and the Android FCM data-message handler decrypt; the relay, Apple and Google
  see only ciphertext.
- Native desktop on React Native (Linux, macOS, Windows) once the desktop platforms of RN mature;
  until then the desktop runs the web build in a native window (`harness web-app`).

Waiting on upstream:

- TypeScript refactorings in TypeScript 7. The native language server (`tsc --lsp`) has no
  refactorings yet (extract function/constant/variable, move to file, infer return type). When
  typescript-go ports them they arrive as code actions (`refactor.*`) through `lsp_code_actions` and
  the `codeAction` operation of `lsp_refactor`; check that it handles their interactive arguments
  (move to file needs a target file).

## License

[MIT](LICENSE)
