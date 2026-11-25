# Nodes and hubs

## Commands

| Command | What it does |
|---|---|
| `harness [-c] [--session <id>]` | The TUI. It connects to the user's running node (`~/.harness/sockets/default.sock`) or runs one inside itself, and to every remote in `remotes.json`. |
| `harness node [--name N] [--config F]` | A node for this user (default name `default`): a unix socket for local clients, links to the hubs of its configuration. |
| `harness hub [--name N] [--listen host:port]` | A node with the hub role, listening for devices and nodes (default `127.0.0.1:8790`; put TLS in front). |
| `harness hub user add <name> [--admin]`, `remove`, `list` | The hub's users. |
| `harness hub device add <user> --name <device>`, `revoke`, `list` | Devices; the token is printed once. |
| `harness hub node add <name> --users a,b`, `revoke`, `list` | Nodes that may link; the key is printed once. |
| `harness remote add <name> <wss://hub>`, `remove`, `list` | The hubs this client connects to; the token is asked for (or `HARNESS_TOKEN`) and kept in `~/.harness/remotes.json` (0600). |

## A node's configuration

`~/.harness/nodes/<name>.json`, or the file `--config` names:

```json
{
  "users": ["alice"],
  "hubs": [{ "url": "wss://hub.example", "keyFile": "/run/keys/harness-work" }],
  "hub": { "listen": "127.0.0.1:8790" }
}
```

`users` are the hub users allowed on this node through its hubs; `hubs` are the hubs it links to
(`key` or `keyFile`, read at every connection attempt); `hub` makes it a hub too.

## Pairing a device

1. On the hub's machine: `harness hub user add alice`, then `harness hub device add alice --name
   laptop [--url https://hub.example]`; copy the token.
2. On a terminal device: `harness remote add work wss://hub.example`, paste the token;
   `harness` there lists alice's nodes next to its own.
3. In a browser or the app: open the link `device add --url` printed (or scan its QR code); see
   [app.md](app.md).

## Logs

Each node logs events to `~/.harness/log/node-<name>.jsonl` (connections, refusals, agents
starting, exiting, unloading; never message texts or secrets) and each agent's output to
`~/.harness/log/agents/<id>.log`.
