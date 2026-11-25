# Remote harness

A [harness](https://github.com/thearchitect/harness) hub on a Fly.io machine: every user works in
their own home under their own uid, through their node on the machine; their TUI (`harness`) and
the harness app connect to the hub over `wss://<app>.fly.dev`. Created with
`nix flake init -t github:thearchitect/harness#remote`.

- `remote.yaml` — the users (name, uid, admin) and the initial settings of new users
- `.cage/` — secrets ([cage](https://github.com/themakers/cage)): the users' API keys, the deploy
  token, the machine identity
- `fly.toml` — one machine with a volume, always on
- `bootstrap.sh` — creates the Fly app, volume, machine secret, deploy token
- `deploy.sh` — builds the image (`nix build .#image`) and deploys it
- `logs.sh` — the event logs of the hub and the users' nodes
- `.github/workflows/deploy.yml` — deploys every push to master

## Setup

Inside `nix develop` (flyctl, skopeo, cage):

1. **Configuration.** Edit `remote.yaml` (users) and `fly.toml` (`app`, region).
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
6. **Devices.** An admin pairs each device of a user (the token is printed once):
   ```bash
   flyctl ssh console -a <app> -C "setpriv --reuid=harness --regid=harness --clear-groups env HOME=/data/home/harness harness hub device add alice --name laptop"
   ```
   On the device: `harness remote add fly wss://<app>.fly.dev` and paste the token. `harness`
   then shows the user's node (`alice`) next to the local one.

Operations (build, test, deploy, secrets, users): `AGENTS.md`.
