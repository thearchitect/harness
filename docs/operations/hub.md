# The hub

A hub is a user's harness on a machine: it runs that user's agents as its children, keeps their
sessions, settings and paired devices in `~/.harness`, and serves the user's clients. A user has
one hub per machine. To work on another machine, connect to that machine's hub.

## Commands

| Command | What it does |
|---|---|
| `harness [-c] [--session <id>]` | The TUI. It connects to the user's hub on this machine (`~/.harness/sockets/default.sock`) or holds it inside itself (below), and to every remote hub in `remotes.json`. |
| `harness hub [--listen host:port] [--config F]` | The user's hub as a service: the unix socket for local clients and, with `--listen`, network access for the user's devices (put TLS in front). |
| `harness hub device add --name <device> [--url <hub address>]`, `revoke --name <device>`, `list` | Devices: a one-time pairing code (ten minutes), with `--url` also its link and QR code. |
| `harness remote add <name> <wss://hub>`, `remove`, `list` | Other machines' hubs this client connects to; the pairing code is asked for (or `HARNESS_PAIRING_CODE`), exchanged for the device token, kept in `~/.harness/remotes.json` (0600). |

## The hub inside a window

The first window of a user (`harness`, `harness web-app`) that finds no hub holds one: the hub
runs inside that window's process and listens on `~/.harness/sockets/default.sock` for the user's
other windows. Agents live as long as their hub: quitting the holding window stops its agents and
their background tasks, so `Ctrl+Q` there asks first while agents work or other windows use it.

When the holder goes, its other windows elect a new one: each tries to create
`~/.harness/locks/node-default.lock` (holding its PID); the one that does holds a new hub, the
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

## Configuration

`~/.harness/nodes/default.json`, or the file `--config` names:

```json
{
  "hub": { "listen": "127.0.0.1:8790", "url": "https://hub.example" },
  "server": false
}
```

`hub` gives the user's devices network access (`url`: the address pairing links name); `server`
declares a shared server without root (the Fly image): its agents get the `server` skill.

## Pairing a device

1. On the hub's machine: `harness hub device add --name laptop [--url https://hub.example]`; it
   prints a one-time code.
2. On a terminal device: `harness remote add work wss://hub.example`, enter the code; `harness`
   there lists that hub next to its own.
3. In a browser or the app: open the link `device add --url` printed (or scan its QR code); see
   [app.md](app.md).

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

The hub logs events to `~/.harness/log/node-default.jsonl` (connections, refusals, agents
starting, exiting, unloading; never message texts or secrets) and each agent's output to
`~/.harness/log/agents/<id>.log`. Clients show the hub's events in the panel (`logs_tail`).
