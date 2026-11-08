{
  description = "harness: pi coding agent bundle (pi + harness extension + pi packages + MCP tools)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # cage pins its own nixpkgs: its vendorHash is computed against it.
  inputs.cage.url = "github:themakers/cage";

  outputs =
    {
      self,
      nixpkgs,
      cage,
    }:
    let
      # The systems CI builds and tests (nix/ci.py); Intel macOS is not one of them.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          bundle = pkgs.callPackage ./nix/package.nix {
            harnessSrc = self;
            cage = cage.packages.${pkgs.stdenv.hostPlatform.system}.default;
          };
        in
        {
          default = bundle;
          harness = bundle;
          inherit (bundle.passthru) npmTools lightpanda;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          harness-telegram = pkgs.callPackage ./nix/remote.nix { inherit bundle; };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # pi-dev: the bundle with the harness extension loaded from the working tree.
          packages = [
            self.packages.${pkgs.stdenv.hostPlatform.system}.default.passthru.piDev
            pkgs.nodejs
            pkgs.jq
            pkgs.curl
          ];
        };
      });

      checks = forAllSystems (
        pkgs:
        {
          bundle = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        }
        // pkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
          # The template's configuration builds into an image.
          remote-image = self.lib.mkRemoteImage {
            inherit pkgs;
            config = ./templates/remote/remote.yaml;
            envs = ./nix/testdata/remote-envs;
            tag = "check";
          };
          # The agents' tools run, prebuilt binaries run through nix-ld.
          remote-tools = (import ./nix/remote-tools.nix pkgs).check;
          # Fly unpacks images of at most 8 GB: the image's closure stays under 7.
          remote-image-size =
            let
              image = self.checks.${pkgs.stdenv.hostPlatform.system}.remote-image;
              closure = pkgs.closureInfo { rootPaths = [ image ]; };
            in
            pkgs.runCommand "remote-image-size" { } ''
              bytes=$(du -scb $(cat ${closure}/store-paths) | tail -1 | cut -f1)
              echo "image closure: $((bytes / 1048576)) MB"
              [ "$bytes" -lt $((7 * 1024 * 1024 * 1024)) ]
              echo "$bytes" > $out
            '';
        }
      );

      # The OCI image of a remote deployment (Telegram gateway): nix/remote-image.nix.
      lib.mkRemoteImage = import ./nix/remote-image.nix self;

      templates.remote = {
        path = ./templates/remote;
        description = "A remote harness deployment: Telegram gateway on Fly.io (cage secrets, CI deploys)";
      };

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
