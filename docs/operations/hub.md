# The hub

A hub is a user's harness on a machine: it runs that user's agents as its children, keeps their
sessions, settings and paired devices in `~/.harness`, and serves the user's clients. A user has
one hub per machine. To work on another machine, connect to that machine's hub.

## Commands

| Command | What it does |
|---|---|
| `harness [-c] [--session <id>]` | The TUI. It connects to the user's hub on this machine (`~/.harness/run/hub.sock`) or holds it inside itself (below), and to every remote hub in `client/remotes.json`. |
| `harness hub [--config F]` | The user's hub as a service, without a window. |
| `harness hub attach` | Joins stdin and stdout to this machine's running hub: what a client elsewhere runs over SSH. It never starts a hub; without one it fails with `harness: no hub runs for user@host (start the service, or open harness there)`. |
| `harness hub network [on\|off] [--listen h:p] [--proxy\|--no-proxy] [--url U]` | The hub's network access (below). |
| `harness hub device add [--name N]`, `list`, `rename --name N --to M`, `revoke --name N` | Paired devices: a one-time pairing code (ten minutes), with its link and QR code when the hub knows its address. |
| `harness connect <address> [--name N] [--command C]` | Another machine's hub, kept in `~/.harness/client/remotes.json` (0600): `ssh://[user@]host[:port]`, or a pairing link `https://hub/#pair=<code>` (or `https://hub` and the code typed). |
| `harness remote list`, `remove <name>` | The hubs this client connects to. |
| `harness logs [--since 1h] [--follow] [--source …] [--agent <id>] [--session <id>] [--json]` | This machine's log, every source merged by time ([Logs](#logs)). |

The hub's commands act on the running hub, so a revoked device is disconnected at once. In any
client, `/hub` (or `hub…` in the panel, `Ctrl+\`) opens the same in a dialog: the network access,
the devices (when each paired, last connected, from where; rename, revoke) and adding a device —
a name, then the code's QR code, its link whole (selectable, `copy link`), `new code`, and whether
it was used or expired.

## The hub inside a window

The first window of a user (`harness`, `harness web-app`) that finds no hub holds one: the hub
runs inside that window's process and listens on `~/.harness/run/hub.sock` for the user's
other windows. Agents live as long as their hub: quitting the holding window stops its agents and
their background tasks, so `Ctrl+Q` there asks first while agents work or other windows use it.

When the holder goes, its other windows elect a new one: each tries to create
`~/.harness/run/hub.lock` (holding its PID); the one that does holds a new hub, the
others connect to it, and the tabs start their agents again from their sessions (the status line
says how many sessions were interrupted). A lock whose process is gone is left over from a crash
and removed.

A hub run as a service is never replaced by a window: its windows wait for its supervisor to
start it again. To keep agents running without a window, run the hub as a user service:

```ini
# ~/.config/systemd/user/harness-hub.service
[Unit]
Description=harness hub

[Service]
ExecStart=%h/.nix-profile/bin/harness hub
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now harness-hub` (and `loginctl enable-linger $USER` to keep it after
logout). On NixOS: `services.harness.hubs.<user>` ([nixos.md](nixos.md)).

A window refuses a local hub of another harness version and exits with the reason, for example
`harness 7e3c99e: hub default runs harness 3bdafe7 (held by window PID 4242); close it or restart
the service`. Remote hubs are checked for a compatible protocol only.

`restart hub` in the panel (`Ctrl+\`) stops every agent of the hub and its processes and starts
the hub again: in its holding window, or by its supervisor for a service (it exits with code 75).

## Reaching a hub from elsewhere

| Way | Encryption | Authentication | For |
|---|---|---|---|
| the unix socket | none needed | the file system: the directory is the user's (0700) | clients on the same machine |
| SSH (`harness connect ssh://user@host`) | SSH | SSH's keys and agent, `~/.ssh/config` | a TUI on another machine |
| the network, behind a TLS proxy | the proxy (Fly, `tailscale serve`, Caddy) | a device paired once by a one-time link | browsers, phones, a TUI with a link |

**SSH.** `harness connect ssh://user@host` runs in a terminal, so ssh can ask once for the host's
key or a passphrase; it checks that `harness hub attach` answers there and keeps `{ name, ssh,
command? }` in `remotes.json` (`--command`: the path of harness there when ssh's non-interactive
PATH lacks it). The client then runs `ssh -T -o BatchMode=yes user@host harness hub attach` and
reconnects with growing pauses; ssh's own complaint (a refused key, no hub running) shows in the
strip and the status line. Agents run on that machine's hub: a dropped connection does not touch
them.

**The network.** The hub has no TLS of its own: it listens for HTTP on `listen` (default
`127.0.0.1:8790`), and an address off loopback is allowed only with `proxy` on — when only a TLS
proxy reaches the port; otherwise the network does not start and `/hub` says why. On that address
the hub serves the app's web build (`/`, always its own version), the protocol (`/ws`) and pairing
(`/pair`). `url` is the address devices use, which pairing links carry. The user's setting
`hub.network` keeps it (the `/hub` dialog, `harness hub network`); a service's configuration
(`network` in `--config`, the NixOS module, the Fly image) sets it instead, read-only in `/hub`.
A hub inside a window opens it too, while the window is open.

Recipes:

```bash
# Tailscale: HTTPS on the tailnet's name, only for its members
harness hub network on --url https://laptop.example.ts.net
tailscale serve --bg 8790
```

```caddyfile
# Caddy on a machine with a domain: its own certificate, renewed by itself
hub.example.com {
  reverse_proxy 127.0.0.1:8790
}
```

Fly.io: [fly.md](fly.md) (the proxy is Fly's; `listen 0.0.0.0:8080` with `proxy`).

## Pairing a device

A pairing link is `https://<hub>/#pair=<code>`: the code stays in the fragment, so it never
reaches a request line, a proxy's log or a Referer. A code lasts ten minutes and pairs once; an
address gets five wrong codes per ten minutes, and five wrong codes in all withdraw the open codes.
The hub keeps only the hash of each device's token (256 bits).

- **A browser** (the link opened, or a phone's camera reading the QR code): the hub serves the
  app, the page exchanges the code (`POST /pair`) for an `HttpOnly; Secure; SameSite=Strict`
  cookie and removes the code from its address; it is in at once, and its WebSocket carries the
  cookie by itself. On a phone the page offers `Open in the app` (`harness://pair?hub=…&code=…`)
  or pairing the browser.
- **The app** (iOS, Android, web): `Scan the QR code` (the camera), or the link pasted or the code
  typed; the token goes to the system's secure storage.
- **A TUI**: `harness connect https://hub/#pair=<code>` (or `+ add` in the strip).

A device's name is the one the code was made with, else the device's own ("Chrome on macOS", the
host's name), renamed in `/hub`. Revoking it closes its connections at once; a revoked device is
told to pair again. The first device of a hub without a window (a Fly machine):
`fly ssh console -C "su <user> -c 'harness hub device add --name laptop'"`.

## Sleeping

With `idleExit` (minutes) in a service's configuration, the hub exits when no client is connected
and no agent works — no run, no question waiting, no background task — for that long. The Fly
image sets ten minutes: the machine stops, and the next request starts it again in seconds.
Sessions stay on the volume; terminals' shells end.

## Configuration

`~/.harness/hub/config.json`, or the file `--config` names:

```json
{
  "network": { "listen": "127.0.0.1:8790", "url": "https://hub.example", "proxy": false },
  "idleExit": 10,
  "server": false
}
```

`network` sets the network access (on when given); `idleExit` lets the service sleep; `server`
declares a shared server without root (the Fly image): its agents get the `server` skill.

## Logging in to providers

`/login` logs in on the session's hub: its `auth.json` keeps the login. Each step of the
provider's flow shows in the client's editor zone: the sign-in link (open it in this machine's
browser, or copy it), a choice, a field for a code or the address the browser ended on. ←
outside the field goes back one step (the flow starts again and answers the steps before by
itself), from the first step back to the providers; Esc cancels.

A sign-in link usually sends the browser back to `127.0.0.1`/`localhost` on a port. A login on
this machine's hub needs nothing more: its flow listens there. For a hub elsewhere the TUI listens
on that port while the step is shown and passes the address on to the hub; when the port is busy
here, or in the app, paste the address the browser ended on into the field.

## Logs

One log for every part, JSON records a line each `{ at, level, source, event, … }`, a file a day
per source under `~/.harness/log/<source>/<YYYY-MM-DD>.jsonl`:

- `hub`: connections and refusals, every operation (its id, arguments — long strings by their
  length —, time and error), every record passed to an agent (the client's id and the one the agent
  gets), agents starting (the session asked for and the one opened), exiting and unloading,
  terminals and the prompt editor, the network, pairing codes made and used (never the codes),
  wrong codes with their address, devices refused, renamed, revoked, going to sleep, the move of
  `~/.harness`.
- `agent`: each agent's start (versions, the session, the model, extensions' problems), every
  request by its id with a prompt's text, each run with its answers (model, stop reason, tokens,
  cost, text), tools with their results, retries, compactions, questions and answers, errors with
  their stacks. Agents send it to their hub; their raw stderr goes to `log/agents/<id>.stderr`.
- `tui`, `app`: the clients' start, connections and why they were lost, every request by its id
  with its time and error, actions, status lines, tabs starting and failing, drafts kept, the
  background loading; at `debug` the TUI's raw key bytes. Clients send theirs to their hub
  (`logs_put`); the app also keeps its own on the device.

One request carries the same id from the client through the hub to the agent. Content is logged;
secrets' values are masked. `log.level` (`error`, `warn`, `info` by default, `debug`) and
`log.retentionDays` (3) are settings; old days are removed at the hub's start and hourly.

`harness logs [--since 1h] [--follow] [--source hub,agent,tui,app] [--agent <id>] [--session <id>]
[--json]` prints them merged by time; the panel's `logs` row shows the last day's.
