# Reading pi's documents in harness

pi's documents (`../pi/coding-agent/README.md`, `../pi/coding-agent/docs/`) describe pi as a
standalone program. In harness the same SDK runs inside agents of a node, so some paths, commands
and APIs differ. Read pi's documents with this table; where a row says "the same", pi's text holds
as written.

## Paths

| pi | harness |
|---|---|
| `~/.pi/agent` | `~/.harness` (`HARNESS_HOME` overrides it) |
| `~/.pi/agent/settings.json` | `~/.harness/settings.json` — pi's settings (model, thinking, packages); UI settings are in `~/.harness/ui-settings.json` |
| `~/.pi/agent/auth.json` | `~/.harness/auth.json` |
| `~/.pi/agent/sessions/` | `~/.harness/sessions/` |
| `~/.pi/agent/extensions/` | `~/.harness/extensions/` |
| `~/.pi/agent/prompts/` | `~/.harness/prompts/` |
| `~/.pi/agent/mcp.json`, `~/.pi/agent/mcp-auth.json`, `~/.pi/agent/mcp.log` | `~/.harness/mcp.json`, `~/.harness/mcp-auth.json`, `~/.harness/mcp.log` |
| `~/.pi/agent/trust.json` | `~/.harness/trust.json` |
| `~/.pi/agent/AGENTS.md` | `~/.harness/AGENTS.md` |
| `~/.pi/agent/tmp/` | `~/.harness/tmp/` |
| — | `~/.harness/harness.json` (defaults of new sessions), `nodes/`, `sockets/`, `locks/`, `log/`, `hub/`, `users/`, `remotes.json` ([operations/settings.md](operations/settings.md)) |

## Commands

| pi | harness |
|---|---|
| `pi` (interactive) | `harness` — the full-screen multi-session TUI |
| `pi auth`, `pi config`, `pi mcp`, `pi install`, `pi remove`, `pi uninstall`, `pi list`, `pi update` | `harness auth`, `harness config`, `harness mcp`, `harness install`, `harness remove`, `harness uninstall`, `harness list`, `harness update` — passed to pi on `~/.harness` |
| `pi --continue`, `pi -c` | `harness -c` |
| `pi --resume`, `pi -r` | Ctrl+O (or `/open`) in the TUI |
| `pi --model`, `pi --list-models` | the model list in the TUI (Ctrl+L); references without versions: [extending/models.md](extending/models.md) |
| `pi --mode`, `pi --print`, `pi -p` | no headless mode of its own: clients speak the node protocol ([protocol/node.md](protocol/node.md)) |
| `pi --tools`, `pi --no-builtin-tools`, `pi -e`, `pi --extension`, `pi -ne`, `pi --append-system-prompt` | not flags: agents load the bundled extensions and packages (the bundle's manifest) and pi's extension discovery; the system prompt is harness's |
| `pi --use-theme` | `ui.theme` in the UI settings |
| `pi --help`, `pi --version` | `harness --help`, `harness --version` |

## APIs

| pi | harness |
|---|---|
| `ctx.ui.select/confirm/input/editor` | the same calls; they become `pi-dialog` interactions every client can answer |
| `ctx.ui.custom()`, component widgets | run in the agent; terminal clients show them through the component bridge, other clients get `undefined` (as in pi's RPC mode). harness's own code uses typed interactions instead ([extending/tools.md](extending/tools.md)) |
| `ctx.ui.setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput`, working indicators, `setTheme` | no effect: the footer, editor, indicators and themes belong to the client |
| `InteractiveMode` | the TUI (`packages/tui`) |
| RPC mode (`rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`) | HAP: pi's RPC records pass unchanged, harness adds `harness_*` records ([protocol/hap.md](protocol/hap.md)) |
| Renderers (`registerTool` renderCall/renderResult, `registerEntryRenderer`, `registerMessageRenderer`, `registerToolRenderer`) | the same; they run in the client, so they must draw from their arguments only |
