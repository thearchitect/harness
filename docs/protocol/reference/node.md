# Node protocol reference

<!-- Generated from packages/protocol/src/schemas.ts by packages/testkit/src/docs/write-reference.ts; do not edit. -->

Frames between a client and a node (or a hub routing to nodes), one JSON object per line ([behavior](../node.md)).

Protocol version: 1.

## Client frames

### `hello`

The first frame of a connection; answered with welcome or refused.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"hello"` | yes |  |
| `protocol` | integer | yes | PROTOCOL_VERSION of the client (version.ts) |
| `client` | string | yes | What the client is: tui, app, test, hub, node |
| `token` | string |  | A device token (hub) or a node key (uplink); none on local endpoints |
| `capabilities` | string[] |  | What the client can draw besides typed data: component-bridge |

### `req`

A control operation; answered with one res frame of the same id.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"req"` | yes |  |
| `id` | string | yes | Chosen by the client; the res frame carries it back |
| `node` | string |  | The node to run it on, through a hub; the connected node when absent |
| `op` | string | yes | A control operation (see Operations) |
| `args` | any | yes | The operation's arguments |

### `hap`

A HAP record for an agent; requests are answered by the agent with the same id.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"hap"` | yes |  |
| `node` | string |  | The agent's node, through a hub |
| `agent` | string | yes | The agent id |
| `rec` | { type } | yes | The HAP record for the agent |

## Node frames

### `welcome`

The answer to hello.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"welcome"` | yes |  |
| `protocol` | integer | yes |  |
| `harness` | string | yes | The node's harness version |
| `node` | string | yes | The node's name |
| `user` | string | yes | Who the connection is: the node's OS user or a hub user |
| `host` | `"client"` \| `"service"` | yes | Who runs the node: a client window holding it, or a service (harness node) |
| `pid` | integer | yes | The node's process |

### `refused`

The connection is refused; the node closes it.

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

A node event.

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"evt"` | yes |  |
| `node` | string | yes |  |
| `event` | any | yes | A node event (see Node events) |

### `hap`

A record of an agent this connection follows in full (and answers to its requests).

| Field | Type | Required | Description |
|---|---|---|---|
| `k` | `"hap"` | yes |  |
| `node` | string | yes |  |
| `agent` | string | yes |  |
| `rec` | any | yes | A HAP record of the agent |

## Operations

### `nodes_list`

The nodes this connection reaches: the node itself (if the user may use it) and, through a hub, the user's nodes with presence. → { nodes }

No fields.

### `sessions_list`

Sessions stored on the node, newest first, with the agent serving each. → { sessions }

| Field | Type | Required | Description |
|---|---|---|---|
| `cwd` | string |  | Only sessions of this directory |

### `agents_list`

The agents running on the node with their summaries. → { agents }

No fields.

### `agent_start`

Starts an agent (or returns the one serving the session already). → { agent }

| Field | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | yes | The session's directory; ~ is the node user's home |
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
| `path` | string | yes | A directory under the node user's home |

### `files_get`

Reads a file. → { path, base64 }

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | A file under the node user's home |

### `files_put`

Writes a file (directories are created). → { path }

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | A file under the node user's home |
| `base64` | string | yes | The content |

### `theme_get`

A theme's colors as hex for clients that draw it themselves, with the names of the themes there are. → { name, appearance, colors, names }

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | A theme name; the user's ui.theme, else dark, when absent |

### `files_upload`

A file the operator hands to a session (dropped, shared, picked), kept in the node's ~/.harness/uploads. → { path }

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | The file's name |
| `base64` | string | yes |  |

### `transcribe`

Speech to text on the node with its user's OpenAI login (gpt-4o-transcribe). → { text }

| Field | Type | Required | Description |
|---|---|---|---|
| `base64` | string | yes | The recording |
| `mime` | string | yes | Its type, e.g. audio/webm |

### `logs_tail`

The node's event log, newest last; its own user, or a hub's admins. → { lines }

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | integer |  |  |

### `node_restart`

Stops every agent and its processes and starts the node again (its own user only): a client holding it restarts it in its process, a service exits for its supervisor to start it. Clients reconnect. → {}

No fields.

### `settings_get`

The user's UI settings (ui.tabs, ui.theme, …): the node user's, or the hub user's. → { settings }

No fields.

### `settings_set`

Changes one setting; every client of the user receives a settings event. → { settings }

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | A setting key |
| `value` | any | yes | Its new value; null removes it |
| `ifRevision` | string |  | The revision (settings.ts settingRevision) of the value this change was made from: another current one answers conflict |

## Node events

### `agents`

The node's agents changed (one started or exited).

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

The user's settings changed (sent only to that user's connections).

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"settings"` | yes |  |
| `settings` | any | yes | The user's settings |

### `nodes`

A hub's nodes came online or went offline.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"nodes"` | yes |  |
| `nodes` | any | yes | NodeInfo[]: name, online, roles |

### `refused`

A node behind a hub refused this client's channel.

| Field | Type | Required | Description |
|---|---|---|---|
| `ev` | `"refused"` | yes |  |
| `error` | any | yes | { code, message } |
