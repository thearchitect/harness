# Architecture

## Processes

- **Agent** (`harness-agent`, `packages/agent`): one pi session with the harness extension, run
  through pi's SDK. It speaks HAP ([protocol/hap.md](protocol/hap.md)) on file descriptor 3 to
  its node; its stdout and stderr go to its log (`~/.harness/log/agents/<id>.log`).
- **Node** (`harness node`, `packages/node`): the agents of one OS user — it starts them, keeps
  one agent per session (`~/.harness/locks/`), unloads idle ones, and serves clients on a unix
  socket (`~/.harness/sockets/<name>.sock`) or in-process. It runs as whoever started it; there is
  no uid switching.
- **Hub** (`harness hub`): a node with the hub role — users, device tokens and node keys, a
  WebSocket endpoint for devices (`/client`) and for nodes that link to it (`/uplink`), routing of
  a client's frames to the node they name, and each hub user's UI settings.
- **Clients**: the TUI (`harness`, `packages/tui`), the app, test drivers. A client reaches its
  local node (the running one, or one it runs inside itself) and any number of hubs at once.

## Packages

```
protocol ◄── client ◄── tui
protocol ◄── node ◄── cli
protocol ◄── extension ◄── agent ──► pi SDK
extension/presentation ◄── tui
testkit ──► all (tests only)
```

| Package | Responsibility |
|---|---|
| `protocol` | Types and schemas of HAP and the node protocol, framing, versions, errors, model references. Isomorphic. |
| `client` | `NodeConnection`, `ClientModel` (nodes, agents, summaries, full transcripts of followed agents), `Workbench` (the screen every UI draws: tabs, items, zones, actions), the keymap. Isomorphic. |
| `extension` | harness inside pi: modes and the gate, the prompt, interactions through the host, HarnessState, background tasks, tools, model references, presentation (renderers and TUI dialogs). Knows nothing of nodes. |
| `agent` | The pi runtime of a session, the HAP server, the extension UI context, the component bridge. |
| `node` | The node and hub roles: agents, sessions, locks, endpoints, auth, routing, uplinks, settings, the event log. |
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
