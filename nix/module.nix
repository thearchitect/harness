# NixOS module: a harness hub for each user who wants one running without a window — a systemd
# service as that user (agents run as that user; sessions and settings live in that user's
# ~/.harness). A user has one hub on a machine: the service, or else the first harness window.
#
#   services.harness.hubs.alice = { };
#   services.harness.hubs.bob = { listen = "127.0.0.1:8790"; url = "https://bob.example.ts.net"; };
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.harness;
  hubOptions =
    { name, ... }:
    {
      options = {
        listen = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "127.0.0.1:8790";
          description = "Network access for the user's devices, behind a TLS proxy (tailscale serve, Caddy); the unix socket only when null.";
        };
        url = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "https://alice.example.ts.net";
          description = "The address devices reach the hub at (pairing links).";
        };
      };
    };
  configFile =
    user: hub:
    pkgs.writeText "harness-hub-${user}.json" (
      builtins.toJSON (
        lib.optionalAttrs (hub.listen != null) {
          hub = {
            inherit (hub) listen;
          }
          // lib.optionalAttrs (hub.url != null) { inherit (hub) url; };
        }
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
    hubs = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule hubOptions);
      default = { };
      description = "A harness hub service by user name.";
    };
  };

  config = lib.mkIf (cfg.hubs != { }) {
    # the command for clients and administration (harness hub device …)
    environment.systemPackages = [ cfg.package ];

    systemd.services = lib.mapAttrs' (
      user: hub:
      lib.nameValuePair "harness-${user}" {
        description = "harness hub of ${user}";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          User = user;
          ExecStart = "${lib.getExe' cfg.package "harness"} hub --config ${configFile user hub}";
          Restart = "on-failure";
          RestartSec = 5;
          # agents and background tasks are the hub's children: stopping the hub stops them
          KillMode = "control-group";
          TimeoutStopSec = 30;
        };
      }
    ) cfg.hubs;
  };
}
