# Operations

A remote harness deployment: the Telegram gateway of
[harness](https://github.com/thearchitect/harness) (`remote/`,
`harness-telegram`) on one Fly.io machine. This repository holds only what is
private: the configuration, the encrypted secrets, the Fly app. Code changes
go to harness.

## What is where

- `flake.nix` — `packages.x86_64-linux.image`: `harness.lib.mkRemoteImage`
  over `remote.yaml` and `.cage/store/envs`; the dev shell (harness bundle
  with `cage`, `flyctl`, `skopeo`, `jq`).
- `remote.yaml` — bot, users (whitelist: Telegram id, uid, git identity,
  public keys), limits, initial pi settings of a new user.
- `.cage/` — secrets. `cage.yaml` is the layout; `.cage/store/` (committed)
  is ciphertext; `.cage/secrets/` is plaintext and never committed.
  The image carries `envs/machine.cage` and `envs/user-<name>.cage` only.
- `fly.toml` — app, region, volume `/data`, the machine identity file,
  `[http_service]` for the webhook.
- `bootstrap.sh` — one-time Fly setup (app, volume, machine secret, deploy
  token). `deploy.sh` — build and deploy the committed tree.
  `move-secrets.sh` — a user's Telegram secrets into this repository.
  `logs.sh` — the gateway's journal.
- On the machine: `/data/home/<name>` (homes, 0700, one uid each; tools the
  agents install with mise/uv/npm/cargo/go live there),
  `/data/gateway/state.json` (which chat runs which agent),
  `/data/gateway/log/` (the journal), `/etc/harness-remote/config.json`
  (`remote.yaml` + image paths).
- In the image for the agents: gh, glab, go, rust, zig, gcc, python3 with
  pydicom/numpy/pillow, uv, node, ffmpeg, ImageMagick, exiftool, dcmtk, zip,
  mise; prebuilt binaries run through nix-ld. More: `extraPackages` in
  `flake.nix` (the image must stay under Fly's 8 GB).

## Build

Everything inside `nix develop`:

```bash
nix flake check            # evaluates the flake
nix build .#image          # the image (a script that streams the tarball)
nix flake update harness   # take the latest harness
```

A broken `remote.yaml` or a missing `machine.cage` fails the build.

## Test

The gateway's code and tests live in harness: `nix/test.sh result`, or
`node --test remote/test/*.test.ts` there. Here:

1. `nix build .#image` — configuration and secrets layout are valid.
2. After a deploy:
   - `./logs.sh --since 1h` shows `gateway.start`, `gateway.webhook`,
     `account.ready` for every user, `gateway.ready`, and no `error`;
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://<app>.fly.dev/telegram`
     answers 401 (no secret); `curl -sI https://<app>.fly.dev/app/` answers
     200 with `Cache-Control: no-cache` and an `ETag`; `/app/api/state`
     without initData answers 401;
   - `flyctl ssh console -a <app>`: pi processes run under the users' uids,
     `/proc/<pid>/environ` of a pi process has no `TELEGRAM_*`, one user
     cannot list another's home.
3. In Telegram: `/new <dir>`, a message, a `!` message, `/stop`, `/status`,
   `/diff`, a voice message, a file; a status line opens the Mini App (Files,
   Models). An admin gets errors in the private chat and `/logs`.

## Publish

- Push to master: CI (`.github/workflows/deploy.yml`) runs
  `cage run @ci-deploy - ./deploy.sh`.
- By hand: `nix develop -c cage run @root - ./deploy.sh` (needs a clean tree;
  the image tag is the short commit).
- Roll back: `flyctl deploy -a <app> --image registry.fly.io/<app>:<older tag>`.
- A deploy interrupts running agents with a notice; sessions stay on disk.
- The machine sleeps when idle and wakes on the next Telegram message.
- A change of the state format (`state.json` version) is not migrated: stop
  the agents, `rm /data/gateway/state.json` over `flyctl ssh`, deploy; users
  start their agents again (`/new`, or resume from the Mini App's history).
- The bot's main Mini App (BotFather → Bot Settings → Mini App) points at
  `https://<app>.fly.dev/app/`; Threaded Mode stays off.

## Secrets

Never print a value: no `cat` of `.cage/secrets`, no values in command
lines; `cage set -stdin`, `cage set -gen`, `cage run`, `cage dump -o <file>`
into a temporary file that is removed right after use.

- Change a value: `cage set -stdin <file> <NAME> < value-file`, then commit
  `.cage/store`.
- Add a recipient (a key): edit `cage.yaml`, `cage encrypt`, commit.
- A user's own secrets (Telegram `/secrets`, `~/.cage` on the server) into
  this repository: `nix develop -c cage run @root - ./move-secrets.sh <name>
  [KEY...]`. It imports them into `<name>:user.env` (adding the file to the
  env `user-<name>`), commits and pushes; the deploy that follows starts with
  the gateway removing those names from the user's store, so every variable
  lives in one place (cage refuses a name from two files). Until that deploy
  the user's own copies keep working.
- The machine identity (`ops:fly-machine-identity`) is the only Fly secret;
  after rotating it, rerun `bootstrap.sh` and deploy.

## Users

1. Add them to `remote.yaml` (a new, never reused uid) and to `.cage/cage.yaml`
   (`<name>`, `server-<name>: []`, `user-<name>` env); put their API keys with
   `cage set -stdin <name>:llm.env <NAME>`; commit, deploy.
2. They write `/key` to the bot: their server SSH key. Add it as
   `server-<name>`, `cage encrypt`, commit, deploy: their keys reach their
   agents.
3. Removing a user: drop them from `remote.yaml` and `cage.yaml`; their home
   stays on the volume until deleted by hand. On its next start the gateway
   drops their workspaces and leaves their groups.

## Telemetry

The gateway journals every event as one JSON line to
`/data/gateway/log/YYYY-MM-DD.jsonl` (UTC days, `telemetry.retentionDays`
of `remote.yaml`, 30 by default) and a short line to stderr (`flyctl logs`).
No message texts, transcripts, file contents or secret values; the bot token
and webhook secret are masked.

- Reading: `nix develop -c cage run @root - ./logs.sh [--since 24h|7d]
  [--level error] [--user NAME] [--kind PREFIX]`; an admin also gets
  `/logs [hours]` as a file in Telegram.
- Alerts: every `error` goes to the admins (`admin: true` in `remote.yaml`)
  in their private chat with the bot, with sound; the same one again after 10
  minutes at the earliest, at most 10 a minute (the rest as `+N more
  errors`). A run that ended without `gateway.stop` (crash, OOM, kill) is
  reported at the next start as `gateway.previous_failed`.
- Kinds: `gateway.*` (start with image and revision, webhook, ready,
  resources every minute, stopping/stop with the reason, crash, fatal,
  previous_failed), `update` (type, user, chat, command), `update.*`
  (stranger, failed), `agent.*` (new, attach, detach, close, start with ms,
  exit with stderr and memory when unexpected, killed, no_room), `run.*`
  (start, end with ms/cost/model/aborted, silent), `pi.*` (stderr,
  extension_error), `rpc.*`, `tg.*` (call failures, chat_gone, pin_denied),
  `file.*` (send, receive), `voice.transcribe`, `files.*` (diff, mkdir,
  download), `models.save`, `account.*` (ready, prepare, login,
  secret_set, secrets_moved), `workspace.*`, `webhook.rejected`,
  `app.*` (action, rejected, error from the page, failed).
- Recipes: why pi died — `--kind agent.exit --level error` (stderr tail and
  `memFreeMb`); what led to a hang — `--user NAME --since 2h`; cost of a
  week — `--since 7d --kind run.end | jq -s 'map(.costUsd // 0) | add'`.

## TODO

- Topics and threads: when Telegram's topics in private chats and groups
  (or Slack-level threads) are good enough, a topic becomes a workspace of
  its own (one agent per topic) on top of the chat-level workspaces.
