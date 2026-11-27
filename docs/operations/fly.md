# Fly.io

`nix flake init -t github:thearchitect/harness#remote` creates a deployment repository: the user
(`remote.yaml`), their encrypted API keys (cage), `fly.toml`, scripts for bootstrap, deploy and
logs, and a CI workflow. Its README and AGENTS.md describe the whole procedure.

The image (`lib.mkRemoteImage`, `nix/remote-image.nix`) runs the user's hub under s6: `harness
hub` as the user's uid with their cage env, listening on `0.0.0.0:8080` with `proxy` on — only
Fly's proxy reaches the port, and it terminates TLS for `https://<app>.fly.dev`. The hub serves the
app there, and devices pair with a link from `/hub` (the first one on the machine's console:
`harness hub device add`).

The machine sleeps: ten minutes without clients and without working agents the hub exits
(`idleExit`), its s6 finish script ends the container, and Fly (`auto_start_machines`, restart
`on-failure`) starts it again at the next request — a device connecting, the app opened — in
seconds. Agents at work keep it awake even with every client gone. At boot the image prepares the
home on the volume. A VM test (`nix/remote-image-test.nix`) boots the image under podman and
pairs a device.
