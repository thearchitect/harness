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
- On the machine: `/data/home/<name>` (homes, 0700, one uid each),
  `/data/gateway/state.json` (which place runs which agent),
  `/etc/harness-remote/config.json` (`remote.yaml` + image paths).

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
   - `flyctl logs -a <app>` shows `listening`, `webhook …` and `<user>: ready`
     for every user, no `fatal`;
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://<app>.fly.dev/telegram`
     answers 401 (no secret);
   - `flyctl ssh console -a <app>`: pi processes run under the users' uids,
     `/proc/<pid>/environ` of a pi process has no `TELEGRAM_*`, one user
     cannot list another's home.
3. In Telegram: `/agent` in a topic, a message, a `!` message, `/stop`.

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
  start their agents again with `/agent` (pi sessions stay on disk).

## Secrets

Never print a value: no `cat` of `.cage/secrets`, no values in command
lines; `cage set -stdin`, `cage set -gen`, `cage run`, `cage dump -o <file>`
into a temporary file that is removed right after use.

- Change a value: `cage set -stdin <file> <NAME> < value-file`, then commit
  `.cage/store`.
- Add a recipient (a key): edit `cage.yaml`, `cage encrypt`, commit.
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
   stays on the volume until deleted by hand.
