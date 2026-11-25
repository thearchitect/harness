# Nodes and hubs

## Commands

| Command | What it does |
|---|---|
| `harness [-c] [--session <id>]` | The TUI. It connects to the user's local node (`~/.harness/sockets/default.sock`) or holds one inside itself (below), and to every remote in `remotes.json`. |
| `harness node [--name N] [--config F]` | A node for this user (default name `default`): a unix socket for local clients, links to the hubs of its configuration. |
| `harness hub [--name N] [--listen host:port]` | A node with the hub role, listening for devices and nodes (default `127.0.0.1:8790`; put TLS in front). |
| `harness hub user add <name> [--admin]`, `remove`, `list` | The hub's users. |
| `harness hub device add <user> --name <device> [--url <hub address>]`, `revoke`, `list` | Devices: a one-time pairing code (ten minutes), with `--url` also its link and QR code. |
| `harness hub node add <name> --users a,b`, `revoke`, `list` | Nodes that may link; the key is printed once. |
| `harness remote add <name> <wss://hub>`, `remove`, `list` | The hubs this client connects to; the pairing code is asked for (or `HARNESS_PAIRING_CODE`), exchanged for the device token, kept in `~/.harness/remotes.json` (0600). |

## The local node

The first window of a user (`harness`, `harness web-app`) that finds no node holds one: the node runs
inside that window's process and listens on `~/.harness/sockets/default.sock` for the user's other
windows. Agents live as long as their node: quitting the holding window stops its agents and their
background tasks, so `Ctrl+Q` there asks first while agents work or other windows use the node.

When the holder goes, its other windows elect a new one: each tries to create
`~/.harness/locks/node-default.lock` (holding its PID); the one that does holds a new node, the others
connect to it, and the tabs start their agents again from their sessions (the status line says how
many sessions were interrupted). A lock whose process is gone is left over from a crash and removed.

A node run as a service is never replaced by a window: its windows wait for its supervisor to start
it again. To keep agents running without a window, run the node as a user service:

```ini
# ~/.config/systemd/user/harness-node.service
[Unit]
Description=harness node

[Service]
ExecStart=%h/.nix-profile/bin/harness node
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now harness-node` (and `loginctl enable-linger $USER` to keep it after
logout). On NixOS: `services.harness.nodes.<name>`.

A window refuses a local node of another harness version and exits with the reason, for example
`harness 7e3c99e: node default runs harness 3bdafe7 (held by window PID 4242); close it or restart the
service`. Remote nodes are checked for a compatible protocol only.

`restart node` in the panel (`Ctrl+\`) stops every agent of the node and its processes and starts
the node again: in its holding window, or by its supervisor for a service (it exits with code 75).
Its own user and a hub's admins may restart it.

## A node's configuration

`~/.harness/nodes/<name>.json`, or the file `--config` names:

```json
{
  "users": ["alice"],
  "hubs": [{ "url": "wss://hub.example", "keyFile": "/run/keys/harness-work" }],
  "hub": { "listen": "127.0.0.1:8790", "url": "https://hub.example" },
  "server": false
}
```

`users` are the hub users allowed on this node through its hubs; `hubs` are the hubs it links to
(`key` or `keyFile`, read at every connection attempt); `hub` makes it a hub too (`url`: the
address pairing links name); `server` declares a shared server without root (the Fly image's
nodes): its agents get the `server` skill.

## Pairing a device

1. On the hub's machine: `harness hub user add alice`, then `harness hub device add alice --name
   laptop [--url https://hub.example]`; it prints a one-time code.
2. On a terminal device: `harness remote add work wss://hub.example`, enter the code;
   `harness` there lists alice's nodes next to its own.
3. In a browser or the app: open the link `device add --url` printed (or scan its QR code); see
   [app.md](app.md).

## Logs

Each node logs events to `~/.harness/log/node-<name>.jsonl` (connections, refusals, agents
starting, exiting, unloading; never message texts or secrets) and each agent's output to
`~/.harness/log/agents/<id>.log`. Clients show a node's events in the panel (`logs_tail`): to
the node's own user, and on a hub to its admins.
