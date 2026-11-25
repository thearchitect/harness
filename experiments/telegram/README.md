# Telegram gateway (history)

The remote frontend of harness before the platform: a gateway that ran `pi --mode rpc` per
Telegram topic as each user's uid, drew the transcript into Telegram messages and a Mini App
(Alpine.js), and slept on Fly.io until a webhook woke it.

The platform replaced it (plans/harness-platform-plan.md): nodes and a hub speak one protocol,
the TUI and the app are its clients, and agents run as the user who runs the node. This copy is
kept as it was at the switch, for reference: it is not built, tested or maintained, and its
imports point at paths that no longer exist.

- `remote/` — the gateway (`main.ts`), its core (`core/`: the RPC client, pool, idle shutdown),
  the Telegram frontend (`telegram/`), the Mini App (`app/`), tests with a fake Bot API (`test/`)
- `nix/package.nix` — its former Nix package (`harness-telegram`)
