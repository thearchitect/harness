# NixOS

The flake's `nixosModules.default` runs any number of nodes, each a systemd service as its own
user:

```nix
{
  imports = [ harness.nixosModules.default ];
  services.harness.nodes = {
    hub = { user = "harness"; hub.listen = "127.0.0.1:8790"; };
    work = {
      user = "alice";
      users = [ "alice" ];
      hubs = [ { url = "wss://hub.example"; keyFile = "/run/keys/harness-work"; } ];
    };
  };
}
```

Each node becomes `harness-<name>.service` (`harness node`, or `harness hub` when `hub.listen`
is set) with its configuration in the Nix store; the key file stays outside it. Agents and their
background tasks are the service's children and stop with it. The `harness` command is installed
for administration. The module's VM test (`nix/module-test.nix`) links a node to a hub as two users.
