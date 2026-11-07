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
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # pi-dev: the bundle with the harness extension loaded from the working tree.
          packages = [
            self.packages.${pkgs.stdenv.hostPlatform.system}.default.passthru.dev
            pkgs.nodejs
            pkgs.jq
            pkgs.curl
          ];
        };
      });

      checks = forAllSystems (pkgs: {
        bundle = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
