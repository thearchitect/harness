# Settings and files

```
~/.harness/
  .gitignore            # "*"
  agent/                # what pi reads (PI_CODING_AGENT_DIR)
    settings.json       #   pi's settings (model, thinking, packages, theme)
    auth.json           #   provider credentials
    models.json, mcp.json, mcp-auth.json, trust.json, keybindings.json
    themes/             #   themes (pi's format)
    subagents/          #   the user's subagent profiles
  hub/                  # the hub's
    settings.json       #   the user's UI settings (below)
    defaults.json       #   defaults of new sessions: variant, madness, model
    workspace.json      #   the open tabs of this hub's sessions and their drafts (below)
    devices.json, pairings.json  # paired devices and pairing codes (hashes)
    config.json         #   a service's configuration when --config names none
    sessions/           #   pi sessions
    attachments/<session>/  # files handed to sessions (pasted, dropped, picked), by content
    claude/             #   claude subagents' transcripts
  client/               # this machine's clients'
    remotes.json        #   other machines' hubs and this device's tokens (0600)
    window.json         #   the TUI windows' state on this machine (below)
  run/                  # while processes live (0700)
    hub.sock            #   the hub's socket
    hub.lock            #   who holds the hub (a window's or the service's pid)
    locks/              #   one agent per session
  log/                  # hub events and agents' output
```

A home of the flat layout of earlier versions is moved to this one when harness first starts on
it: everything is archived to `~/.harness.backup-<date>.tgz` first, then pi's files go to `agent/`,
`ui-settings.json` (its tabs into `hub/workspace.json`) and `harness.json` to `hub/`, the window's
state to `client/window.json` (its drafts into the workspace), `remotes.json` to `client/`; the files
of the old multi-user hub (`users/`, `hub/users.json`, `hub/nodes.json`) are removed, and the window
says so. A move stopped halfway goes on at the next start; an older hub still running stops it
until that hub is closed.

## The workspace

Each hub keeps the user's open tabs of its sessions in `workspace.json`, in order, each with what of
it was seen (which clears its ✓/✗) and its draft — the message being written there, shared by every
device: begun on one, finished on another. A draft goes to the hub at most once a second and at once
on leaving its tab or quitting; the field being typed in is never overwritten by another device's
write. Changes of the tabs carry the revision they were read at, so clients changing them at once
keep each other's.

A session belongs there once it differs from a new one: a message, a draft (text or an attached
file), a name. Until then it is its window's alone and closing it leaves nothing; wiped back to a
new one (no message, the draft empty) it is its window's alone again. A tab whose session has a
draft and no message yet comes back after a restart as a new session in its folder with the draft;
one whose session file is gone is removed, and the status line says so.

Files pasted, dropped or picked go to the hub at once (`attachments/<session>/<sha256>.<ext>`), never
to a temporary directory, so a draft naming them lasts; one that no draft and no transcript names is
removed after `attachments.retentionDays`.

## A window's state

What depends on the screen — where each tab's transcript was scrolled, expanded tool output, the
item shown, the terminal shown — the active tab and the hub chosen in the strip belong to the
client: the TUI keeps them in `client/window.json` (written under its lock and merged by tab, so two
windows keep each other's tabs; the active tab and hub are the window's that closed last), the web
app in the browser's `localStorage`, the phone apps in a file of their own. They are kept at most
every half second and on quitting.

## UI settings

Shared by every client of the user: the hub's `ui-settings.json`. Clients read them with `settings_get` and change them with
`settings_set`; every client of the user receives the change at once.

| Key | Meaning |
|---|---|
| `attachments.retentionDays` | Days after which a file handed to a session that no draft and no transcript names is removed (default 7). |
| `ui.theme` | The theme (pi's built-in name or a file in `themes/`). |
| `ui.font.chat`, `ui.font.chrome` | The app's fonts of its two zones: `{ family, size }`, family `jetbrains-mono`, `iosevka-term`, `terminus` or `system` ([app.md](app.md)). |
| `ui.web.panes` | The app's strip width: `{ left }` in pixels. |
| `ui.scrollOff.vertical`, `ui.scrollOff.horizontal` | How far a field's cursor stays from its edges while the text goes on: lines in the chat's field (2), characters in single-line fields (10); at the text's ends the cursor comes to the edge. |
| `ui.web.notifications` | The app's notifications when a session waits (default off). |
| `hub.network` | The hub's network access: `{ enabled, listen, proxy, url }` (default off, `127.0.0.1:8790`); the `/hub` dialog changes it, a service's configuration overrides it ([hub.md](hub.md)). |
| `ui.prefetch` | What clients load ahead in the background, whole, so a session opens at once: `all` (default: the window's tabs, then every stored session of the nodes' lists, newest first), `tabs` (the window's tabs only), `off`. |
| `ui.transcript.cacheBlocks` | How many transcript blocks (entries) keep their drawn components in the TUI; past it the least recently drawn ones let them go and are made again when seen. Default: no limit. |

## Defaults of new sessions

`harness.json` keeps the last choice of the simple mode, madness and the model reference (written
under `harness.json.lock`: every agent of the user may write it); a new session starts with them and
records its own values in its entries. The implementer is the session's alone: a new session starts
with `self`.
