{
  description = "harness: a multi-session coding agent platform on pi (nodes, protocol, TUI, agents, pinned tools)";

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
          system = pkgs.stdenv.hostPlatform.system;
          # The real browser of the `browser` MCP server, never built locally:
          # Chromium comes prebuilt from cache.nixos.org (Linux only); on macOS
          # Google Chrome, which nixpkgs repackages from Google's release (unfree,
          # allowed for this one package; not redistributable, so never exported
          # to the harness binary cache - nix/cache-export.sh).
          browser =
            if pkgs.stdenv.hostPlatform.isLinux then
              pkgs.chromium
            else
              (import nixpkgs {
                inherit system;
                config.allowUnfreePredicate = p: pkgs.lib.getName p == "google-chrome";
              }).google-chrome;
          bundle = pkgs.callPackage ./nix/package.nix {
            harnessSrc = self;
            cage = cage.packages.${system}.default;
            inherit browser;
          };
        in
        {
          default = bundle;
          harness = bundle;
          inherit (bundle.passthru) npmTools lightpanda;
        }
      );

      devShells = forAllSystems (
        pkgs:
        let
          bundle = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        {
          default = pkgs.mkShell {
            # harness-dev: the bundle running the working tree; what the tests
            # need (the language servers' toolchains, git for the fixtures,
            # coreutils' timeout on macOS).
            packages = [
              bundle.passthru.harnessDev
              bundle.passthru.harnessTest
              pkgs.nodejs
              pkgs.jq
              pkgs.curl
            ]
            ++ bundle.passthru.toolchain
            ++ [
              pkgs.git
              pkgs.zip
              pkgs.unzip
              pkgs.findutils
              pkgs.coreutils
            ];
          };
        }
      );

      checks = forAllSystems (
        pkgs:
        let
          bundle = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        {
          inherit bundle;
          # Type check, unit and integration tests of the sources (nix/check.sh).
          tests = pkgs.callPackage ./nix/check.nix { inherit bundle; };
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # The NixOS module in a VM: a hub and a node linked to it, as two users.
          module = import ./nix/module-test.nix { inherit pkgs self; };
        }
        // {
          # Every bundled tool on the user's PATH (nix/smoke.sh in CI).
          bundle-full = self.packages.${pkgs.stdenv.hostPlatform.system}.default.override {
            bundled = {
              go = "path";
              rust = "path";
              ffmpeg = "path";
              exiftool = "path";
            };
          };
        }
      );

      # services.harness.nodes.<name>: nodes as systemd services, each as its own user (nix/module.nix).
      nixosModules.default = import ./nix/module.nix { inherit self; };

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
