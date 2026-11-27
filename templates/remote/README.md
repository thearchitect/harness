# Remote harness

A user's [harness](https://github.com/thearchitect/harness) hub on a Fly.io machine: the user's
sessions run there under their uid; their TUI (`harness`) and the harness app connect to it over
`wss://<app>.fly.dev`. Created with `nix flake init -t github:thearchitect/harness#remote`.

- `remote.yaml` — the user (name, uid) and their initial settings
- `.cage/` — secrets ([cage](https://github.com/themakers/cage)): the user's API keys, the deploy
  token, the machine identity
- `fly.toml` — one machine with a volume
- `bootstrap.sh` — creates the Fly app, volume, machine secret, deploy token
- `deploy.sh` — builds the image (`nix build .#image`) and deploys it
- `logs.sh` — the hub's event log
- `.github/workflows/deploy.yml` — deploys every push to master

## Setup

Inside `nix develop` (flyctl, skopeo, cage):

1. **Configuration.** Edit `remote.yaml` (the user) and `fly.toml` (`app`, region).
2. **Secrets.** Edit `.cage/cage.yaml` (keys), then:
   ```bash
   cage keygen -comment fly-machine ops:fly-machine-identity   # → recipients.fly-machine
   cage keygen -comment actions-ci ops:ci-cage-identity        # → recipients.actions-ci
   cage set -stdin alice:llm.env DEEPSEEK_API_KEY < key.txt && rm key.txt
   ```
3. **Fly.** `flyctl auth login`, then `./bootstrap.sh`.
4. **Repository and CI.** Commit, push to a private repository, and give CI its identity without
   printing it:
   ```bash
   cage dump -o ci.key ops:ci-cage-identity && gh secret set CAGE_SSH_IDENTITY < ci.key; rm ci.key
   ```
5. **Deploy.** `cage run @root - ./deploy.sh` (or push).
6. **Devices.** Pair the first device on the machine (the code lasts ten minutes, once):
   ```bash
   flyctl ssh console -a <app> -C "su alice -c 'harness hub device add --name laptop'"
   ```
   It prints a link and its QR code: open it in a browser (it is the app, paired at once), scan it
   with the app, or on a terminal `harness connect <link>`. Later devices: `/hub`, add device, in any
   client already paired.

Operations (build, test, deploy, secrets, devices): `AGENTS.md`.
