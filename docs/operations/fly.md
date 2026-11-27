# Fly.io

`nix flake init -t github:thearchitect/harness#remote` creates a deployment repository: the user
(`remote.yaml`), their encrypted API keys (cage), `fly.toml`, scripts for bootstrap, deploy and
logs, and a CI workflow. Its README and AGENTS.md describe the whole procedure.

The image (`lib.mkRemoteImage`, `nix/remote-image.nix`) runs the user's hub under s6: `harness
hub` as the user's uid with their cage env, on port 8080 behind Fly's TLS. At boot it prepares
the home on the volume. Devices connect to `wss://<app>.fly.dev` once paired on the machine
(`harness hub device add`). A VM test (`nix/remote-image-test.nix`) boots the image under podman
and pairs a device.
