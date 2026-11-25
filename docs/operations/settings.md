# Settings and files

```
~/.harness/
  .gitignore            # "*"
  settings.json         # pi's settings (model, thinking, packages, theme)
  ui-settings.json      # the UI settings of the node's user (below)
  auth.json             # provider credentials (pi)
  harness.json          # defaults of new sessions: variant, madness, model
  remotes.json          # this client's hubs and device tokens (0600)
  sessions/             # pi sessions
  locks/                # one agent per session
  sockets/<name>.sock   # local endpoints (directory 0700)
  nodes/<name>.json     # node configuration (and node keys of linked nodes)
  hub/                  # a hub's users, devices and node keys (hashes)
  users/<user>/         # a hub's per-user UI settings
  themes/               # themes (pi's format)
  log/                  # node events and agents' output
  uploads/              # files handed to sessions from the app (dropped, picked)
```

## UI settings

Shared by every client of the user: through a hub, the hub user's (`users/<user>/`); otherwise
the node user's `ui-settings.json`. Clients read them with `settings_get` and change them with
`settings_set`; every client of the user receives the change at once.

| Key | Meaning |
|---|---|
| `ui.tabs` | The open session tabs, in order: `{ node, sessionId, sessionFile, cwd, seen }`; `seen` clears the ✓/✗ of what the user has looked at. |
| `ui.theme` | The theme (pi's built-in name or a file in `themes/`). |
| `ui.font.chat`, `ui.font.chrome` | The app's fonts of its two zones: `{ family, size }`, family `jetbrains-mono`, `iosevka-term`, `terminus` or `system` ([app.md](app.md)). |
| `ui.web.panes` | The app's strip widths: `{ left, right }` in pixels. |
| `ui.web.notifications` | The app's notifications when a session waits (default off). |

## Defaults of new sessions

`harness.json` keeps the last choice of the simple mode, madness and the model reference (written
under `harness.json.lock`: every agent of the user may write it); a new session starts with them and
records its own values in its entries. The implementer is the session's alone: a new session starts
with `self`.
