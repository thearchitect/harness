# NixOS module: any number of harness nodes, each a systemd service running as its own user
# (agents run as that user; sessions and settings live in that user's ~/.harness).
#
#   services.harness.nodes.work = { user = "alice"; hubs = [ { url = "wss://hub.example"; keyFile = "/run/keys/harness-work"; } ]; };
#   services.harness.nodes.hub  = { user = "harness"; hub.listen = "127.0.0.1:8790"; };
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.harness;
  nodeOptions =
    { name, ... }:
    {
      options = {
        user = lib.mkOption {
          type = lib.types.str;
          description = "The user the node and its agents run as; its home holds ~/.harness.";
        };
        users = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Hub users allowed on this node through its hubs.";
        };
        hubs = lib.mkOption {
          type = lib.types.listOf (
            lib.types.submodule {
              options = {
                url = lib.mkOption {
                  type = lib.types.str;
                  description = "The hub's WebSocket base (ws:// or wss://).";
                };
                keyFile = lib.mkOption {
                  type = lib.types.str;
                  description = "A file with the node's key from `harness hub node add` (outside the Nix store).";
                };
              };
            }
          );
          default = [ ];
          description = "Hubs the node connects out to.";
        };
        hub.listen = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "127.0.0.1:8790";
          description = "Run the node as a hub listening here (behind a TLS reverse proxy).";
        };
      };
    };
  configFile =
    name: node:
    pkgs.writeText "harness-node-${name}.json" (
      builtins.toJSON (
        {
          inherit (node) users;
          hubs = map (hub: { inherit (hub) url keyFile; }) node.hubs;
        }
        // lib.optionalAttrs (node.hub.listen != null) { hub.listen = node.hub.listen; }
      )
    );
in
{
  options.services.harness = {
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "harness.packages.\${system}.default";
      description = "The harness bundle.";
    };
    nodes = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule nodeOptions);
      default = { };
      description = "Harness nodes by name.";
    };
  };

  config = lib.mkIf (cfg.nodes != { }) {
    # the command for clients and administration (harness hub user|device|node …)
    environment.systemPackages = [ cfg.package ];

    systemd.services = lib.mapAttrs' (
      name: node:
      lib.nameValuePair "harness-${name}" {
        description = "harness node ${name} (${node.user})";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          User = node.user;
          ExecStart = "${lib.getExe' cfg.package "harness"} ${
            if node.hub.listen != null then "hub" else "node"
          } --name ${lib.escapeShellArg name} --config ${configFile name node}";
          Restart = "on-failure";
          RestartSec = 5;
          # agents and background tasks are the node's children: stopping the node stops them
          KillMode = "control-group";
          TimeoutStopSec = 30;
        };
      }
    ) cfg.nodes;
  };
}
