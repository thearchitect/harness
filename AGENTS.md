# harness: rules for agents

Before every commit, with the changes staged (`git add`: the flake builds only
git-tracked files), run the step's minimum and commit only when it passes:

- `nix build` (a new extension file must be listed in the extension fileset of
  `nix/package.nix`: the bundle is what users get);
- `tsc -p .` (and `tsc -p packages/app/tsconfig.json` when the app changed);
- `nix/check.sh <the tests the change touches>`: it runs them from the
  checkout (its `node_modules` must point at the bundle's: `harness-dev` sets
  it).

Before pushing `master`, run the full check and push only when it passes:

```bash
nix develop --command nix flake check -L
```

It builds the bundle and runs every test on it, the smoke tests of the built
bundle and the virtual machines (the NixOS module, the remote image).
`master` is what users install and update to, and CI checks it only after the
push. The sources run as TypeScript on node (types stripped, no build step):
a new package directory or source file needs no Nix change; a new npm
dependency goes into `nix/npm/package.json` and its regenerated lock.

## Invariants

- There are clients and hubs, nothing else. A hub is single-user: it runs as
  its user and keeps its state in the user's home (`~/.harness`). A user has
  exactly one hub per machine, run as a user service or held inside the first
  harness window on that machine (the same code as a library).
- A hub executes every session itself: agents are its child processes, on its
  machine. There are no executors elsewhere, ever. Work on another machine goes
  through that machine's hub.
- Clients reach a hub by its unix socket (`~/.harness/run/hub.sock`: the
  filesystem's permissions are the authentication), over SSH (`ssh user@host
  harness hub attach`, which only connects to a running hub and never starts
  one), or over HTTP behind a TLS proxy (Fly, `tailscale serve`, Caddy) when
  the hub enables network access: a device pairs once by a one-time link
  (`https://<hub>/#pair=<code>`) and keeps its token (a browser as an HttpOnly
  cookie); the hub keeps only its hash and never terminates TLS itself. One
  protocol (JSON records) over all three. A client may be connected to several
  hubs.
- The hub keeps everything of the user: sessions, the workspace (tabs, their
  order, drafts and attachments), user settings, devices, logs. A client keeps
  only what depends on its screen (scroll, expanded output, the item shown, the
  active tab per hub, the chosen hub), its device settings and its list of hubs
  with their credentials.
- A session is empty while its state equals its initial state (no entries,
  empty draft, no attachments, no name, initial model and modes); what decides
  is the comparison, not the history of actions. An empty session belongs to
  its window alone and leaves nothing behind; a changed one joins the workspace
  with its draft.
- A window shows either a session (transcript and editor) or the choice of a
  new session's folder; nothing in between.
- Input follows one policy (`packages/client/src/input/`): exactly one mode
  owns the keyboard — chat, dialog, panel or capture. Global actions are
  Ctrl+key and Alt+key alike, always both, never other duplicates, and act in
  every mode but capture; capture (terminal, prompt editor, an extension's
  component) takes all input but its own exit. Unmodified keys belong to the
  mode; Esc goes back one level. Field editing uses no letter chords.
- The editor zone has two forms: a completion above the editor (top rule only)
  and a dialog in the editor's place (top and bottom rules), both in the
  theme's `border` color.
- Logs are full and structured (JSONL with ids that follow a request from
  client to hub to agent), on the hub and on clients, kept `log.retentionDays`
  (3 by default); secrets' values are always masked.

## Architecture, UI and UX

- One model, every client: the Workbench and the agent models decide; the TUI
  and the app only draw them, with the same keys, rows and words.
- pi first: pi's components and semantics are used as they are; a deviation is
  written down in the plan's deviations.
- Every control works by keyboard, click and hover; key releases never act.
- Keys: ↑↓ move between rows and leave a field, ← goes back outside a field,
  Enter applies, Esc closes or cancels; typing goes to the step's field at once.
- One single-line input (LineField): a cursor that moves with the arrows, the
  terminal's own cursor as in the chat's editor, a column kept for it at the
  end, no padding.
- Text the operator copies (links, codes, output) has no padding; links are
  clickable and have open and copy actions.
- Things happen where the operator is: links open on the client's machine; a
  browser's callback reaches a remote node through the client.
- Cost does not grow with a session: transcripts are virtual, drawn by visible
  rows, cached per width; sessions load in the background ahead of use, so
  opening one is instant; memory is spent before time.
- State is the hub's; a window's view is the client's and survives restarts;
  concurrent writers merge by revision or lock — consistency is predictable.
- Every user-facing behavior has a scenario on the built bundle; prompts and
  tools have golden files.

## Testing the product

- Tests run the product, not a copy of it. A client's window is put together
  once (`packages/cli/src/window.ts`) for `harness` and the tests' drivers
  alike; a driver may give only the effects outside the window (terminal,
  clipboard, browser, where views are kept).
- The golden path (`tests/smoke/golden-path.test.ts`) runs the bundle's real
  `bin/harness` in a pseudo-terminal and the web app its hub serves: a change
  to the start, the protocol, the client or a UI passes it before a commit
  (`HARNESS_BUNDLE=$(nix build --print-out-paths) nix/check.sh
  tests/smoke/golden-path.test.ts`).
- How the product looks is tested: `tests/smoke/screens.test.ts` compares the
  TUI's and the web's screens with their reviewed baselines and checks the
  rules of layout. A change to a UI is looked at on the run's sheet
  (`.test-reports/<run>/screens/<theme>/sheet.png`) and what was seen is
  reported; baselines are accepted (`HARNESS_UPDATE_SCREENS=1`) only after.
- Checks by hand go through the instrumentation: `harness-test up --product
  [--web] [--kitty]`, `harness-test up <scenario>`, their `do`, `state`,
  `shot`, `logs`. No tmux, `script` or ad-hoc runs: what the instrumentation
  lacks is added to it, and the check stays a test.
