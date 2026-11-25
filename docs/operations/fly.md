# Fly.io

`nix flake init -t github:thearchitect/harness#remote` creates a deployment repository: the
users (`remote.yaml`), their encrypted API keys (cage), `fly.toml`, scripts for bootstrap, deploy
and logs, and a CI workflow. Its README and AGENTS.md describe the whole procedure.

The image (`lib.mkRemoteImage`, `nix/remote-image.nix`) runs s6: `harness hub` as the user
`harness` on port 8080 behind Fly's TLS, and `harness node` for each user as their own uid with
their cage env, linked to the hub over localhost. At boot it prepares the homes on the volume and
registers the users and their node keys at the hub once. The machine stays on; devices connect
to `wss://<app>.fly.dev` after an admin pairs them. A VM test (`nix/remote-image-test.nix`) boots
the image under podman.
