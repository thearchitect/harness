# The hub protocol

A client and a hub exchange frames, one JSON object per line on a unix socket, a WebSocket or
in-process; fields are in the [reference](reference/hub.md).

## Handshake

The client's first frame is `hello` (protocol version, what the client is, a device token on the
network endpoint, capabilities). The hub answers `welcome` (its protocol and harness versions,
its name, who holds it) or `refused` with the reason (`version_mismatch`, `unauthorized`,
`invalid_record`) and closes. A unix socket trusts its owner: the socket's directory is the
user's (0700). The hub is its user's alone: every connection it accepts is that user.

## Transports

The same frames go over the hub's unix socket, over SSH (`ssh user@host harness hub attach` joins
ssh's stdio to that machine's socket) and over the network endpoint's WebSocket (`/ws`).

## Devices

On the network endpoint a device connects to `wss://<hub>/ws` with its device token in `hello`,
or, for a browser, with its `harness_device` cookie (from the hub's own page only: its Origin must
be the hub's). A device gets its token by pairing: `device_pair` (`/hub`, `harness hub device
add`) makes a one-time code (ten minutes, stored as a SHA-256 hash); the device sends it to `POST
https://<hub>/pair { code, name?, cookie? }` and receives `{ device, token }` — or, with
`cookie: true`, `{ device }` and the token as an `HttpOnly; Secure; SameSite=Strict` cookie. The
token is stored as a hash; the code is spent. `POST /unpair` from the hub's page revokes the
browser's device and clears its cookie. `device_revoke` closes a device's connections at once
(`refused` with `unauthorized`). `hub_status` and the `hub` event tell the network access, the
devices and the codes of the last ten minutes.

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
at most one agent of the user on the machine (`~/.harness/run/locks/`).

## Errors

Every failed request names a code (`packages/protocol/src/errors.ts`): `unauthorized`,
`forbidden`, `not_found`, `version_mismatch`, `session_locked`, `invalid_record`,
`agent_failed`, `conflict`, `internal`.
