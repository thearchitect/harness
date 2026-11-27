# Hub protocol reference

<!-- Generated from packages/protocol/src/schemas.ts by packages/testkit/src/docs/write-reference.ts; do not edit. -->

Frames between a client and a hub, one JSON object per line ([behavior](../hub.md)).

Protocol version: 1.

## Client frames

### `hello`

The first frame of a connection; answered with welcome or refused.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"hello"` | yes |  |
| `protocol` | integer | yes | PROTOCOL_VERSION of the client (version.ts) |
| `client` | string | yes | What the client is: tui, app, test |
| `token` | string |  | A device token on the network endpoint; none on local endpoints |
| `capabilities` | string[] |  | What the client can draw besides typed data: component-bridge |

### `req`

A control operation; answered with one res frame of the same id.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"req"` | yes |  |
| `id` | string | yes | Chosen by the client; the res frame carries it back |
| `op` | string | yes | A control operation (see Operations) |
| `args` | any | yes | The operation's arguments |

### `hap`

A HAP record for an agent; requests are answered by the agent with the same id.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"hap"` | yes |  |
| `agent` | string | yes | The agent id |
| `rec` | { type } | yes | The HAP record for the agent |

## Hub frames

### `welcome`

The answer to hello.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"welcome"` | yes |  |
| `protocol` | integer | yes |  |
| `harness` | string | yes | The hub's harness version |
| `hub` | string | yes | The hub's name |
| `host` | `"client"` \| `"service"` | yes | Who runs the hub: a client window holding it, or a service (harness hub) |
| `pid` | integer | yes | The hub's process |

### `refused`

The connection is refused; the hub closes it.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"refused"` | yes |  |
| `error` | any | yes | { code, message } (errors.ts) |

### `res`

The answer to a req.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"res"` | yes |  |
| `id` | string | yes |  |
| `ok` | boolean | yes |  |
| `data` | any |  | The operation's result |
| `error` | any |  | { code, message } |

### `evt`

A hub event.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"evt"` | yes |  |
| `event` | any | yes | A hub event (see Hub events) |

### `hap`

A record of an agent this connection follows in full (and answers to its requests).

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"hap"` | yes |  |
| `agent` | string | yes |  |
| `rec` | any | yes | A HAP record of the agent |

## Operations

### `sessions_list`

Sessions stored on the hub, newest first, with the agent serving each. → { sessions }

| Field | Type | Required | Description |
|---|---|---|---|
| `cwd` | string |  | Only sessions of this directory |

### `session_read`

A stored session's entries without its agent, as harness_snapshot and harness_entries_before give them: the current branch, oldest first. → { entries, cursor?, mtime }

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | yes | A session file from sessions_list |
| `cursor` | string |  | From an earlier answer: the entries before it |
| `limit` | integer |  | How many entries (200 by default) |

### `agents_list`

The agents running on the hub with their summaries. → { agents }

No fields.

### `agent_start`

Starts an agent (or returns the one serving the session already). → { agent }

| Field | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | yes | The session's directory; ~ is the hub user's home |
| `sessionFile` | string |  | Open this stored session; a new one when absent |
| `subagent` | { profile, role, mode, model, tools, subagents, madness, depth } |  | How the child runs as a subagent; only an agent's own connection may start one |
| `background` | boolean |  | A subagent that outlives its parent |

### `agent_attach`

Follows an agent; at the full level the answer carries the snapshot and the stream continues after it. → { agent, snapshot? }

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | string | yes | The agent id |
| `level` | `"full"` \| `"summary"` | yes | full: snapshot and live stream; summary: summaries only |

### `agent_detach`

Stops following an agent; it keeps running. → {}

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | string | yes | The agent id |

### `agent_close`

Stops an agent; its session stays. → {}

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | string | yes | The agent id |

### `files_list`

Lists a directory. → { path, items }

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | A directory under the hub user's home |

### `dirs_list`

The directories in a directory, by name, each with hasChildren (it holds directories itself), for choosing where a session starts. → { path, parent, home, dirs }

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | A directory of the hub's machine: absolute, ~ or ~/… |
| `hidden` | boolean |  | Directories whose names start with a dot too |

### `files_get`

Reads a file. → { path, base64 }

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | A file under the hub user's home |

### `files_put`

Writes a file (directories are created). → { path }

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | A file under the hub user's home |
| `base64` | string | yes | The content |

### `theme_get`

A theme's colors as hex for clients that draw it themselves, with the names of the themes there are. → { name, appearance, colors, names }

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | A theme name; the user's ui.theme, else dark, when absent |

### `attachments_put`

A file the operator hands to a session (pasted, dropped, shared, picked), kept with its attachments by content (~/.harness/attachments/<session>/<sha256>.<ext>). → { path }

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | string | yes | The session's id |
| `name` | string | yes | The file's name (its extension is kept) |
| `base64` | string | yes |  |

### `workspace_get`

The user's workspace on this hub: its tabs (session, file, directory, seen, draft) in order, and its revision. → { revision, tabs }

No fields.

### `workspace_tabs_set`

Arranges the tabs: order, seen, closed ones gone. → { revision, tabs }

| Field | Type | Required | Description |
|---|---|---|---|
| `tabs` | any | yes | WorkspaceTab[]: the tabs as arranged; their drafts are kept from the hub's |
| `ifRevision` | integer | yes | The revision they were read at: another one is refused (conflict) |

### `workspace_draft_set`

A session's draft, the last write winning: the session joins the tabs when it differs from a new one, and leaves them when it does not and has no message on disk. → { revision, tabs }

| Field | Type | Required | Description |
|---|---|---|---|
| `tab` | any | yes | { sessionId, sessionFile, cwd } |
| `text` | string | yes | The message being written |
| `keep` | boolean | yes | The session differs from a new one besides its draft (a message, a name) |

### `workspace_tab_replace`

A tab's session started anew in its place (its file was never written). → { revision, tabs }

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes |  |
| `next` | any | yes | { sessionId, sessionFile } |

### `transcribe`

Speech to text on the hub with its user's OpenAI login (gpt-4o-transcribe). → { text }

| Field | Type | Required | Description |
|---|---|---|---|
| `base64` | string | yes | The recording |
| `mime` | string | yes | Its type, e.g. audio/webm |

### `logs_tail`

The hub's event log, newest last. → { lines }

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | integer |  |  |

### `terminal_open`

Shows a session's terminal to this client: a shell in its directory on this hub, started at the first show (and again after it exited); the stream follows as terminal_output events. → { screen } (its screen with history as ANSI)

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | string | yes | The session's id |
| `cwd` | string | yes | Its directory |
| `cols` | integer | yes |  |
| `rows` | integer | yes |  |

### `terminal_input`

Input to a session's terminal. → {}

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | string | yes |  |
| `data` | string | yes | Bytes for the shell, as a terminal sends them |

### `terminal_resize`

The terminal's size (the last client's wins). → {}

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | string | yes |  |
| `cols` | integer | yes |  |
| `rows` | integer | yes |  |

### `terminal_detach`

Hides the terminal from this client; the shell runs on. → {}

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | string | yes |  |

### `hub_restart`

Stops every agent and its processes and starts the hub again (its own user only): a client holding it restarts it in its process, a service exits for its supervisor to start it. Clients reconnect. → {}

No fields.

### `settings_get`

The user's UI settings (ui.theme, hub.network, …). → { settings }

No fields.

### `settings_set`

Changes one setting; every client of the user receives a settings event. → { settings }

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | A setting key |
| `value` | any | yes | Its new value; null removes it |
| `ifRevision` | string |  | The revision (settings.ts settingRevision) of the value this change was made from: another current one answers conflict |

### `hub_status`

The hub's network access (settings, where they come from, whether it runs and why not) and its paired devices and pairing codes. → HubStatus

No fields.

### `hub_network_set`

Changes the network access (the user's hub.network setting); refused when the service's configuration sets it. → HubStatus

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean |  |  |
| `listen` | string |  | host:port of the HTTP endpoint; off loopback only with proxy |
| `proxy` | boolean |  | Only a TLS proxy in front reaches the port (Fly, tailscale serve, Caddy) |
| `url` | string |  | The address devices use, for pairing links |

### `device_pair`

A one-time code for a new device, for ten minutes. → { id, code, expires, link? }

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | The device's name; else the one it gives when it pairs |

### `device_rename`

Renames a paired device. → HubStatus

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes |  |
| `to` | string | yes |  |

### `device_revoke`

Revokes a paired device; its connections close at once. → HubStatus

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes |  |

## Hub events

### `agents`

The hub's agents changed (one started or exited).

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"agents"` | yes |  |
| `agents` | any | yes | AgentInfo[] |

### `summary`

An agent's summary changed; at most 4 per second per agent.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"summary"` | yes |  |
| `agent` | string | yes |  |
| `summary` | any | yes | AgentSummary: status, mode, title, waiting, tasks, lastOutcome, lastActivity, costUsd |

### `agent_exited`

An agent's process ended.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"agent_exited"` | yes |  |
| `agent` | string | yes |  |
| `code` | integer \| null | yes |  |
| `error` | string |  |  |

### `settings`

The user's settings changed.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"settings"` | yes |  |
| `settings` | any | yes | The user's settings |

### `terminal_output`

Output of a session's terminal this client shows.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"terminal_output"` | yes |  |
| `session` | string | yes |  |
| `data` | string | yes | Bytes of the shell as text |

### `terminal_exit`

A session's terminal shell exited; terminal_open starts another.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"terminal_exit"` | yes |  |
| `session` | string | yes |  |
| `code` | integer | yes |  |

### `hub`

The network access or the devices changed (one paired, connected, was revoked).

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"hub"` | yes |  |
| `status` | any | yes | HubStatus |

### `workspace`

The workspace changed: a tab opened, moved, closed, seen; a draft written.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"workspace"` | yes |  |
| `workspace` | any | yes | { revision, tabs } |
