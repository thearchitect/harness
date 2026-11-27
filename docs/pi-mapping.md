# Reading pi's documents in harness

pi's documents (`../pi/coding-agent/README.md`, `../pi/coding-agent/docs/`) describe pi as a
standalone program. In harness the same SDK runs inside agents of a hub, so some paths, commands
and APIs differ. Read pi's documents with this table; where a row says "the same", pi's text holds
as written.

## Paths

| pi | harness |
|---|---|
| `~/.pi/agent` | `~/.harness/agent` (pi's agent directory; `HARNESS_HOME` moves `~/.harness`) |
| `~/.pi/agent/settings.json` | `~/.harness/agent/settings.json` — pi's settings (model, thinking, packages); UI settings are in `~/.harness/hub/settings.json` |
| `~/.pi/agent/auth.json` | `~/.harness/agent/auth.json` |
| `~/.pi/agent/sessions/` | `~/.harness/hub/sessions/` (pi's `sessionDir` setting still wins) |
| `~/.pi/agent/extensions/` | `~/.harness/agent/extensions/` |
| `~/.pi/agent/prompts/` | `~/.harness/agent/prompts/` |
| `~/.pi/agent/mcp.json`, `~/.pi/agent/mcp-auth.json`, `~/.pi/agent/mcp.log` | `~/.harness/agent/mcp.json`, `~/.harness/agent/mcp-auth.json`, `~/.harness/agent/mcp.log` |
| `~/.pi/agent/trust.json` | `~/.harness/agent/trust.json` |
| `~/.pi/agent/AGENTS.md` | `~/.harness/agent/AGENTS.md` |
| `~/.pi/agent/tmp/` | `~/.harness/agent/tmp/` |
| — | `~/.harness/hub/` (defaults of new sessions, the workspace, devices, attachments), `client/`, `run/`, `log/` ([operations/settings.md](operations/settings.md)) |

## Commands

| pi | harness |
|---|---|
| `pi` (interactive) | `harness` — the full-screen multi-session TUI |
| `pi auth`, `pi config`, `pi mcp`, `pi install`, `pi remove`, `pi uninstall`, `pi list`, `pi update` | `harness auth`, `harness config`, `harness mcp`, `harness install`, `harness remove`, `harness uninstall`, `harness list`, `harness update` — passed to pi on `~/.harness` |
| `pi --continue`, `pi -c` | `harness -c` |
| `pi --resume`, `pi -r` | Ctrl+O (or `/open`) in the TUI |
| `pi --model`, `pi --list-models` | the model list in the TUI (Ctrl+L); references without versions: [extending/models.md](extending/models.md) |
| `pi --mode`, `pi --print`, `pi -p` | no headless mode of its own: clients speak the hub protocol ([protocol/hub.md](protocol/hub.md)) |
| `pi --tools`, `pi --no-builtin-tools`, `pi -e`, `pi --extension`, `pi -ne`, `pi --append-system-prompt` | not flags: agents load the bundled extensions and packages (the bundle's manifest) and pi's extension discovery; the system prompt is harness's |
| `pi --use-theme` | `ui.theme` in the UI settings |
| `pi --help`, `pi --version` | `harness --help`, `harness --version` |

## APIs

| pi | harness |
|---|---|
| `ctx.ui.select/confirm/input/editor` | the same calls; they become `pi-dialog` interactions every client can answer |
| `ctx.mode` | `"tui"`: harness always has the operator's interface, so extensions draw for a terminal (pi's `/mcp` opens its manager) |
| `ctx.ui.custom()`, component widgets | run in the agent; the TUI and the app show them through the component bridge — the app as a remote terminal (ANSI lines in a monospace font, keys as terminal bytes, pasted text, clicks at a cell; a key strip on phones). Without such a client the component waits and the status line says so. harness's own code uses typed interactions instead ([extending/tools.md](extending/tools.md)) |
| an MCP server's sign-in link (`openUrl`) | opened by the clients where they run (the TUI's machine, the app's browser), not on the hub; the link is in the status line too |
| `ctx.ui.setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput`, working indicators, `setTheme` | no effect: the footer, editor, indicators and themes belong to the client |
| `InteractiveMode` | the TUI (`packages/tui`) |
| RPC mode (`rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`) | HAP: pi's RPC records pass unchanged, harness adds `harness_*` records ([protocol/hap.md](protocol/hap.md)) |
| Renderers (`registerTool` renderCall/renderResult, `registerEntryRenderer`, `registerMessageRenderer`, `registerToolRenderer`) | the same; they run in the client, so they must draw from their arguments only |
