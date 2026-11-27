# NixOS

The flake's `nixosModules.default` runs a harness hub as a systemd service for each user who
wants one without a window open:

```nix
{
  imports = [ harness.nixosModules.default ];
  services.harness.hubs = {
    alice = { };
    bob = { listen = "127.0.0.1:8790"; url = "https://bob.example.ts.net"; };
  };
}
```

Each hub becomes `harness-<user>.service` (`harness hub`) running as that user, with its
configuration in the Nix store. `listen` gives the user's devices network access behind a TLS
proxy (`tailscale serve`, Caddy); `url` is the address pairing links carry. Agents and their
background tasks are the service's children and stop with it. A user has one hub on a machine:
with the service running, that user's harness windows connect to it instead of holding one. The
`harness` command is installed for `harness hub device …`. The module's VM test
(`nix/module-test.nix`) runs two users' hubs and pairs a device with one.
