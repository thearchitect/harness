# Architecture

## Processes

- **Agent** (`harness-agent`, `packages/agent`): one pi session with the harness extension, run
  through pi's SDK. It speaks HAP ([protocol/hap.md](protocol/hap.md)) on file descriptor 3 to
  its hub, its log records too; its stderr goes to `~/.harness/log/agents/<id>.stderr`.
- **Hub** (`harness hub`, `packages/hub`): one OS user's harness on one machine — it starts the
  user's agents, keeps one agent per session (`~/.harness/run/locks/`), unloads idle ones, keeps the
  user's settings and paired devices, and serves clients on a unix socket
  (`~/.harness/run/hub.sock`), in-process, or over the network for paired devices. A
  user has one hub per machine: a service, or held inside the first window. It runs as whoever
  started it; there is no uid switching.
- **Clients**: the TUI (`harness`, `packages/tui`), the app, test drivers. A client reaches its
  machine's hub (the running one, or one it runs inside itself) and any number of other
  machines' hubs at once.

## Packages

```
protocol ◄── client ◄── tui
protocol ◄── hub ◄── cli
protocol ◄── extension ◄── agent ──► pi SDK
extension/presentation ◄── tui
testkit ──► all (tests only)
```

| Package | Responsibility |
|---|---|
| `protocol` | Types and schemas of HAP and the hub protocol, framing, versions, errors, model references. Isomorphic. |
| `client` | `HubConnection`, `ClientModel` (hubs, agents, summaries, full transcripts of followed agents), `Workbench` (the screen every UI draws: tabs, items, zones, actions), the keymap. Isomorphic. |
| `extension` | harness inside pi: modes and the gate, the prompt, interactions through the host, HarnessState, background tasks, tools, model references, presentation (renderers and TUI dialogs). Knows nothing of hubs. |
| `agent` | The pi runtime of a session, the HAP server, the extension UI context, the component bridge. |
| `hub` | The hub: agents, sessions, locks, endpoints, paired devices, settings, terminals, the event log. |
| `tui` | The full-screen terminal UI over `Workbench`. |
| `cli` | `harness` and its subcommands. |
| `testkit` | Stands, scenarios, drivers, captures, reports, galleries, `harness-test`. |

The graph is checked by `tests/boundaries.test.ts`: allowed imports per package, no Node API in
`protocol` and `client`, no cycles.

## Rules that hold everywhere

- Interactions with the operator are typed (`gate`, `secret`, `questions`, `choice`, `display`,
  `pi-dialog`): the extension asks through the host, every client draws them its own way, the first
  answer wins. pi's `ctx.ui.custom()` components run in the agent and reach terminal clients
  through the component bridge; other clients get `undefined`, as in pi's RPC mode.
- Renderers are pure functions of what the protocol carries (arguments, results, `details`,
  entries), so a client draws a session it did not see happen.
- Time comes from an injected `Clock` wherever behavior depends on it; tests move it.
- The screen is the `Workbench`'s: TUI and app draw the same zones (main, above the editor, the
  editor or what takes its place, status, footer, overlays) and run the same actions.
