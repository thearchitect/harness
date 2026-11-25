# The node protocol

A client and a node exchange frames, one JSON object per line on a unix socket, a WebSocket or
in-process; fields are in the [reference](reference/node.md).

## Handshake

The client's first frame is `hello` (protocol version, what the client is, a token when the
endpoint needs one, capabilities). The node answers `welcome` (its protocol and harness versions,
its name, who the connection is) or `refused` with the reason (`version_mismatch`,
`unauthorized`, `invalid_record`) and closes. A unix socket trusts its owner: the socket's
directory is the user's (0700).

## Operations and events

`req` frames run control operations (start, attach, list, files, settings) and get one `res` with
the same id. `evt` frames tell every allowed connection what changed: the agents, their summaries,
the user's settings (only to that user), presence of nodes behind a hub.

## Following agents

`agent_attach` at the `summary` level gives only `summary` events (status, mode, title, waiting
interactions, tasks, the last outcome), at most four per second per agent. At the `full` level
the answer carries the agent's snapshot and the agent's records follow in `hap` frames
([hap.md](hap.md#snapshot-and-stream)). Clients follow every agent at the summary level and only
the active tab and a few recently visited ones in full.

Agents do not depend on clients: detaching or disconnecting leaves an agent running. The node
unloads an agent nobody follows in full that has no run, no open interaction and no live task
after 30 minutes; its session stays and opens again with `agent_start`. One session is served by
at most one agent of the user on the machine (`~/.harness/locks/`).

## Errors

Every failed request names a code (`packages/protocol/src/errors.ts`): `unauthorized`,
`forbidden`, `not_found`, `node_offline`, `version_mismatch`, `session_locked`,
`invalid_record`, `agent_failed`, `internal`.
