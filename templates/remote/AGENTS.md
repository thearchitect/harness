# Operations

A remote harness deployment: a user's [harness](https://github.com/thearchitect/harness) hub on
one Fly.io machine. This repository holds only what is private: the configuration, the encrypted
secrets, the Fly app. Code changes go to harness.

## What is where

- `flake.nix` — `packages.x86_64-linux.image`: `harness.lib.mkRemoteImage` over `remote.yaml` and
  `.cage/store/envs`; the dev shell (harness bundle with `cage`, `flyctl`, `skopeo`, `jq`).
- `remote.yaml` — the user (name, uid) and their initial `~/.harness/settings.json`.
- `.cage/` — secrets. `cage.yaml` is the layout; `.cage/store/` (committed) is ciphertext;
  `.cage/secrets/` is plaintext and never committed. The image carries `envs/user-<name>.cage`
  only: the hub and its agents get its variables.
- `fly.toml` — app, region, volume `/data`, the machine identity file, `[http_service]` for the
  hub's network endpoint.
- `bootstrap.sh` — one-time Fly setup. `deploy.sh` — build and deploy the committed tree.
  `logs.sh` — the hub's event log.
- On the machine: s6 supervises `harness hub` as the user's uid on port 8080. Home:
  `/data/home/<name>` (0700; sessions in `~/.harness/sessions`, paired devices in
  `~/.harness/hub/` as hashes only, the event log in `~/.harness/log/`).
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
   - `./logs.sh` shows `hub_start` and no refusals;
   - `flyctl ssh console -a <app>`: `ps` shows `harness hub` under the user's uid;
     `/proc/<pid>/environ` of the hub has no `CAGE_SSH_IDENTITY`;
   - from a paired device: `harness` lists the hub, starts a session there, a message gets its
     answer.

## Publish

- Push to master: CI (`.github/workflows/deploy.yml`) runs `cage run @ci-deploy - ./deploy.sh`.
- By hand: `nix develop -c cage run @root - ./deploy.sh` (needs a clean tree; the image tag is
  the short commit).
- Roll back: `flyctl deploy -a <app> --image registry.fly.io/<app>:<older tag>`.
- A deploy restarts the hub: running agents stop, sessions stay on disk and open again from any
  client.

## Secrets

Never print a value: no `cat` of `.cage/secrets`, no values in command lines; `cage set -stdin`,
`cage set -gen`, `cage run`, `cage dump -o <file>` into a temporary file that is removed right
after use.

- Change a value: `cage set -stdin <file> <NAME> < value-file`, then commit `.cage/store`.
- Add a recipient (a key): edit `cage.yaml`, `cage encrypt`, commit.
- The machine identity (`ops:fly-machine-identity`) is the only Fly secret; it decrypts the
  user's env for the hub. After rotating it, rerun `bootstrap.sh` and deploy.

## Devices

Pair a device on the machine (README, step 6); list or revoke them with
`harness hub device list|revoke --name <device>` run the same way.

## Telemetry

The hub logs events as JSON lines to `~/.harness/log/node-default.jsonl` (connections,
refusals, agents starting, exiting, unloading). `./logs.sh` reads them; `flyctl logs` shows the
processes' stderr.
