# HAP: the harness agent protocol

HAP is the stream between an agent and its node, and through the node between the agent and each
client that follows it in full. It is pi's RPC ([rpc.md](../../pi/coding-agent/docs/rpc.md)) with
records added: pi's commands, responses, session events and extension UI records pass unchanged
([rpc-commands.md](../../pi/coding-agent/docs/rpc-commands.md),
[rpc-extension-ui.md](../../pi/coding-agent/docs/rpc-extension-ui.md)); harness adds `harness_*`
records, listed with their fields in the [reference](reference/hap.md).

## Framing

JSON objects, one per line ([framing](../../pi/coding-agent/docs/rpc.md#framing)): LF separates
records, a CR before it is dropped, U+2028 and U+2029 are not separators. Between agent and node
the stream runs on file descriptor 3, so nothing an extension prints can break it.

## Requests and answers

A client's `harness_*` request carries an `id` and gets exactly one `harness_response` with that
id (`ok` with `data`, or `error` with `code` and `message`). The node rewrites ids on the way to
the agent and back, so clients choose ids freely and only the asking client gets the answer. pi's
commands get pi's `response` records the same way.

A request that does not match its schema is answered with `invalid_record` and does nothing.

## Snapshot and stream

A client that attaches in full gets a snapshot (`harness_snapshot`): the newest entries of the
current branch with a cursor for older ones (`harness_entries_before`), the message and tool calls
in flight, the session view, HarnessState, open interactions, statuses and bridged components.
Live records follow only after the snapshot, and the agent's stream is ordered, so the snapshot
and the records after it neither lose nor repeat anything. After a compaction the client takes a
new snapshot.

## Interactions

`harness_interaction_request` opens an interaction for the operator; any client may answer with
`harness_interaction_response`. The first answer wins; every client then gets
`harness_interaction_closed` with the reason (`answered`, `cancelled` when the run's signal
aborted, `ended` when the agent stops).

## Bridged components

When an extension calls `ctx.ui.custom()`, the agent asks how many clients following it in full
declared the `component-bridge` capability (the node keeps it current with `harness_clients`).
With none, `custom()` resolves `undefined` at once. Otherwise `harness_component_open` announces
the component, `harness_component_render` carries its ANSI lines after every render request, the
client sends keys (`harness_component_input`) and its width (`harness_component_resize`), and
`harness_component_close` ends it on every client.

## Versions

`harness_hello` carries the agent's protocol version and harness version. A node refuses agents
and clients of an incompatible protocol version (`version_mismatch`).
