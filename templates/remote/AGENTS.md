# Operations

A remote harness deployment: a [harness](https://github.com/thearchitect/harness) hub and one
node per user on one Fly.io machine. This repository holds only what is private: the
configuration, the encrypted secrets, the Fly app. Code changes go to harness.

## What is where

- `flake.nix` — `packages.x86_64-linux.image`: `harness.lib.mkRemoteImage` over `remote.yaml` and
  `.cage/store/envs`; the dev shell (harness bundle with `cage`, `flyctl`, `skopeo`, `jq`).
- `remote.yaml` — users (name, uid, admin) and the initial `~/.harness/settings.json` of a new user.
- `.cage/` — secrets. `cage.yaml` is the layout; `.cage/store/` (committed) is ciphertext;
  `.cage/secrets/` is plaintext and never committed. The image carries `envs/user-<name>.cage`
  only: each user's node and agents get its variables.
- `fly.toml` — app, region, volume `/data`, the machine identity file, `[http_service]` for the
  hub's WebSocket endpoint.
- `bootstrap.sh` — one-time Fly setup. `deploy.sh` — build and deploy the committed tree.
  `logs.sh` — event logs.
- On the machine: s6 supervises `harness hub` (user `harness`, port 8080) and `harness node`
  per user (their uid, linked to the hub over localhost). Homes: `/data/home/<name>` (0700, one
  uid each; sessions in `~/.harness/sessions`); the hub's users, devices and node keys in
  `/data/home/harness/.harness/hub/` (hashes only); event logs in `~/.harness/log/`.
- In the image for the agents: gh, glab, go, rust, zig, gcc, python3 with pydicom/numpy/pillow,
  uv, node, ffmpeg, ImageMagick, exiftool, dcmtk, zip, mise; prebuilt binaries run through
  nix-ld. More: `extraPackages` in `flake.nix` (the image must stay under Fly's 8 GB).

## Build

Everything inside `nix develop`:

```bash
nix flake check            # evaluates the flake
nix build .#image          # the image (a script that streams the tarball)
nix flake update harness   # take the latest harness
```

## Test

1. `nix build .#image` — configuration and secrets layout are valid.
2. After a deploy:
   - `./logs.sh` shows `node_start` of the hub and of every user's node, and no refusals;
   - `flyctl ssh console -a <app>`: `ps` shows each `harness node` under its user's uid;
     `/proc/<pid>/environ` of a node has no `CAGE_SSH_IDENTITY`; one user cannot list another's
     home;
   - from a paired device: `harness` lists the user's node, starts a session there, a message gets
     its answer.

## Publish

- Push to master: CI (`.github/workflows/deploy.yml`) runs `cage run @ci-deploy - ./deploy.sh`.
- By hand: `nix develop -c cage run @root - ./deploy.sh` (needs a clean tree; the image tag is
  the short commit).
- Roll back: `flyctl deploy -a <app> --image registry.fly.io/<app>:<older tag>`.
- A deploy restarts the hub and the nodes: running agents stop, sessions stay on disk and open
  again from any client.

## Secrets

Never print a value: no `cat` of `.cage/secrets`, no values in command lines; `cage set -stdin`,
`cage set -gen`, `cage run`, `cage dump -o <file>` into a temporary file that is removed right
after use.

- Change a value: `cage set -stdin <file> <NAME> < value-file`, then commit `.cage/store`.
- Add a recipient (a key): edit `cage.yaml`, `cage encrypt`, commit.
- The machine identity (`ops:fly-machine-identity`) is the only Fly secret; it decrypts the users'
  envs for their nodes. After rotating it, rerun `bootstrap.sh` and deploy.

## Users

1. Add them to `remote.yaml` (a new, never reused uid) and to `.cage/cage.yaml` (`<name>`,
   `user-<name>` env); put their API keys with `cage set -stdin <name>:llm.env <NAME>`; commit,
   deploy. The boot registers the user and their node at the hub.
2. Pair their devices (README, step 6).
3. Removing a user: drop them from `remote.yaml` and `cage.yaml`, and on the machine
   `harness hub user remove <name>` (as the hub user); their home stays on the volume until
   deleted by hand.

## Telemetry

The hub and every node log events as JSON lines to `~/.harness/log/node-<name>.jsonl` of their
user (connections, refusals, agents starting, exiting, unloading); no message texts, prompts or
secret values. `./logs.sh [--node NAME]` reads them; `flyctl logs` shows the processes' stderr.
