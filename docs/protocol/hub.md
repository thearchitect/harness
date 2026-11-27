# The hub protocol

A client and a hub exchange frames, one JSON object per line on a unix socket, a WebSocket or
in-process; fields are in the [reference](reference/hub.md).

## Handshake

The client's first frame is `hello` (protocol version, what the client is, a device token on the
network endpoint, capabilities). The hub answers `welcome` (its protocol and harness versions,
its name, who holds it) or `refused` with the reason (`version_mismatch`, `unauthorized`,
`invalid_record`) and closes. A unix socket trusts its owner: the socket's directory is the
user's (0700). The hub is its user's alone: every connection it accepts is that user.

## Devices

On the network endpoint a device connects to `wss://<hub>/client` with its device token in
`hello`. A device gets its token by pairing: `harness hub device add --name <device>` makes a
one-time code (ten minutes, stored as a SHA-256 hash); the device sends it to `POST
https://<hub>/pair { code }` and receives `{ device, token }` (the token stored as a hash; the
code is spent).

## Operations and events

`req` frames run control operations (start, attach, list, files, settings) and get one `res` with
the same id. `evt` frames tell every connection what changed: the agents, their summaries, the
user's settings.

## Following agents

`agent_attach` at the `summary` level gives only `summary` events (status, mode, title, waiting
interactions, tasks, the last outcome), at most four per second per agent. At the `full` level
the answer carries the agent's snapshot and the agent's records follow in `hap` frames
([hap.md](hap.md#snapshot-and-stream)).

Agents do not depend on clients: detaching or disconnecting leaves an agent running. The hub
unloads an agent nobody follows in full that has no run, no open interaction and no live task
after 30 minutes; its session stays and opens again with `agent_start`. One session is served by
at most one agent of the user on the machine (`~/.harness/locks/`).

## Errors

Every failed request names a code (`packages/protocol/src/errors.ts`): `unauthorized`,
`forbidden`, `not_found`, `version_mismatch`, `session_locked`, `invalid_record`,
`agent_failed`, `conflict`, `internal`.
