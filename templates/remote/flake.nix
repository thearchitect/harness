{
  description = "A remote harness deployment: the Telegram gateway on Fly.io";

  inputs.harness.url = "github:thearchitect/harness";
  inputs.nixpkgs.follows = "harness/nixpkgs";

  outputs =
    {
      self,
      harness,
      nixpkgs,
    }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
    in
    {
      packages.x86_64-linux.image = harness.lib.mkRemoteImage {
        inherit pkgs;
        config = ./remote.yaml;
        envs = ./.cage/store/envs;
        # Tools the agents may use besides the base userland.
        extraPackages = [ ];
        tag = self.shortRev or "dirty";
      };

      # flyctl, skopeo and jq for bootstrap.sh and deploy.sh; cage comes with
      # the harness bundle.
      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = [
          harness.packages.x86_64-linux.default
          pkgs.flyctl
          pkgs.skopeo
          pkgs.jq
          pkgs.yq-go
        ];
      };
    };
}
