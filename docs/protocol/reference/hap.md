# HAP reference

<!-- Generated from packages/protocol/src/schemas.ts by packages/testkit/src/docs/write-reference.ts; do not edit. -->

The records harness adds to pi's RPC between a client and an agent ([behavior](../hap.md)).

Protocol version: 1.

## Requests

### `harness_snapshot`

The agent's state for a client that attaches: entries, the run in flight, the session view, HarnessState, open interactions and components.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_snapshot"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `limit` | integer | yes | The newest entries to include |

### `harness_entries_before`

Older entries of the current branch, for scrolling up.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_entries_before"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `cursor` | string | yes | From a snapshot or an earlier answer |
| `limit` | integer | yes |  |

### `harness_prompt`

A message in an explicit mode; steers when a run is on. Answered after pi's preflight with { disposition }.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_prompt"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `text` | string | yes | The message |
| `mode` | `"plan"` \| `"build"` \| `"simple"` |  | The run's mode |
| `images` | { type, data, mimeType }[] |  | Attached images |

### `harness_set`

Changes the session's harness state; answered with the new HarnessState.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_set"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `variant` | string |  | advanced (PLAN/BUILD) or simple |
| `madness` | boolean |  | Changes without gates |
| `implementer` | string |  | self or a subagent profile |
| `model` | string |  | A model reference (provider/family[:thinking]) to select and follow |

### `harness_interrupt`

"/-": stops the long calls in flight and steers the reason.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_interrupt"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `reason` | string | yes | Steered to the model |

### `harness_interaction_response`

Answers an open interaction; the first answer wins, others get closed: answered.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_interaction_response"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `interactionId` | string | yes |  |
| `answer` | any | yes | The answer of the interaction's kind |

### `harness_task_stop`

Stops a background task (its process group).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_task_stop"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `taskId` | string | yes |  |

### `harness_task_input`

Input for a background task.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_task_input"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `taskId` | string | yes |  |
| `data` | string | yes | Written to the task's stdin |

### `harness_task_output`

A background task's output.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_task_output"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `taskId` | string | yes |  |
| `offset` | integer | yes | Byte offset in the task's output |
| `limit` | integer | yes | Bytes at most |

### `harness_subagent_send`

Operator steering of a live subagent.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_subagent_send"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `session` | string | yes | A live subagent session |
| `text` | string | yes |  |

### `harness_complete`

Completions of paths on the agent's machine.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_complete"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `kind` | `"path"` \| `"file"` | yes |  |
| `prefix` | string | yes |  |

### `harness_component_input`

Keys for a bridged component.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_component_input"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `componentId` | string | yes |  |
| `data` | string | yes | Keys as the terminal sends them |

### `harness_component_resize`

The width a bridged component is drawn at.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_component_resize"` | yes |  |
| `id` | string | yes | Chosen by the client; harness_response carries it back |
| `componentId` | string | yes |  |
| `width` | integer | yes |  |

## Events

### `harness_hello`

The agent is ready (node only).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_hello"` | yes |  |
| `protocol` | integer | yes |  |
| `harness` | string | yes |  |
| `session` | any | yes | SessionView |

### `harness_response`

The answer to a harness request.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_response"` | yes |  |
| `id` | string | yes |  |
| `ok` | boolean | yes |  |
| `data` | any |  | The result |
| `error` | any |  | { code, message } |

### `harness_state`

The whole HarnessState after a change.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_state"` | yes |  |
| `state` | any | yes | HarnessState: variant, madness, implementer, mode, model, tasks, subagents |

### `harness_session`

pi's view of the session changed.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_session"` | yes |  |
| `session` | any | yes | SessionView: id, file, name, cwd, model, thinking, activity, queue, usage |

### `harness_interaction_request`

An interaction opens for the operator.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_interaction_request"` | yes |  |
| `request` | any | yes | InteractionRequest: id, kind, payload, toolCallId?, openedAt |

### `harness_interaction_closed`

An interaction closed.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_interaction_closed"` | yes |  |
| `interactionId` | string | yes |  |
| `reason` | string | yes | answered, cancelled, expired or ended |

### `harness_task_output`

Output of a background task.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_task_output"` | yes |  |
| `taskId` | string | yes |  |
| `offset` | integer | yes |  |
| `chunk` | string | yes |  |

### `harness_ui`

An extension's UI call that every client can show (the method's fields follow).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_ui"` | yes |  |
| `method` | string | yes | notify, status, widget, editor_text, title |

### `harness_component_open`

A bridged component opens (terminal clients).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_component_open"` | yes |  |
| `componentId` | string | yes |  |
| `overlay` | boolean | yes |  |

### `harness_component_render`

A bridged component's new lines.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_component_render"` | yes |  |
| `componentId` | string | yes |  |
| `lines` | string[] | yes | ANSI lines |

### `harness_component_close`

A bridged component closed.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"harness_component_close"` | yes |  |
| `componentId` | string | yes |  |
