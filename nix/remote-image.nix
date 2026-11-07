# lib.mkRemoteImage: the OCI image of a remote harness deployment (Linux).
#
#   harness.lib.mkRemoteImage {
#     pkgs;                 # nixpkgs of the image's system
#     config;               # remote.yaml: Telegram, users, limits, default pi settings
#     envs;                 # cage store envs: machine.cage (required), user-<name>.cage
#     extraPackages ? [ ];  # tools for the agents (gh, glab, toolchains)
#     name ? "harness-remote";
#     tag ? "latest";
#   }
#
# The image holds the harness bundle, the Telegram gateway, cage, a base
# userland and the deployment's configuration and encrypted secrets: plaintext
# never enters it. /etc/passwd lists the configured users with their homes on
# the volume (/data/home/<name>); the gateway runs as root and starts every
# user's pi under their uid.
self:
{
  pkgs,
  config,
  envs,
  extraPackages ? [ ],
  name ? "harness-remote",
  tag ? "latest",
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  bundle = self.packages.${system}.default;
  telegram = self.packages.${system}.harness-telegram;
  inherit (bundle.passthru) cage;

  # remote.yaml → the gateway's config.json (with the image's paths), passwd,
  # group, and the env files the image carries. Built, not evaluated: no IFD.
  etc = pkgs.runCommand "${name}-etc" { nativeBuildInputs = [ pkgs.yq-go pkgs.jq ]; } ''
    mkdir -p $out/etc/harness-remote/envs $out/etc/ssh
    yq -o=json '.' ${config} > remote.json
    jq \
      --arg pi ${bundle}/bin/pi \
      --arg cage ${cage}/bin/cage \
      '. + {
        runAs: "users",
        dataDir: "/data",
        paths: {
          pi: $pi,
          cage: $cage,
          envsDir: "/etc/harness-remote/envs",
          machineIdentity: "/run/harness/machine-identity"
        }
      }' remote.json > $out/etc/harness-remote/config.json
    {
      echo "root:x:0:0:root:/root:/bin/bash"
      jq -r '.users[] | "\(.name):x:\(.uid):\(.uid):\(.name):/data/home/\(.name):/bin/bash"' remote.json
      echo "nobody:x:65534:65534:nobody:/var/empty:/bin/false"
    } > $out/etc/passwd
    {
      echo "root:x:0:"
      jq -r '.users[] | "\(.name):x:\(.uid):"' remote.json
      echo "nogroup:x:65534:"
    } > $out/etc/group
    echo "hosts: files dns" > $out/etc/nsswitch.conf
    # Agents run git over SSH unattended: trust a host key on first use.
    printf 'Host *\n  StrictHostKeyChecking accept-new\n' > $out/etc/ssh/ssh_config

    if [ ! -f ${envs}/machine.cage ]; then
      echo "mkRemoteImage: ${envs}/machine.cage is missing (the machine env: bot token, webhook secret)" >&2
      exit 1
    fi
    cp ${envs}/machine.cage $out/etc/harness-remote/envs/
    for env in ${envs}/user-*.cage; do
      if [ -e "$env" ]; then cp "$env" $out/etc/harness-remote/envs/; else :; fi
    done
  '';
in
pkgs.dockerTools.streamLayeredImage {
  inherit name tag;
  contents =
    [
      etc
      bundle
      telegram
      cage
    ]
    ++ (with pkgs; [
      bashInteractive
      coreutils
      findutils
      gnugrep
      gnused
      gawk
      diffutils
      gnutar
      gzip
      which
      procps
      less
      git
      openssh
      curl
      jq
      cacert
      tzdata
    ])
    ++ extraPackages;
  extraCommands = ''
    mkdir -p tmp root data run/harness usr/bin
    chmod 1777 tmp
    ln -sf ${pkgs.coreutils}/bin/env usr/bin/env
  '';
  config = {
    Cmd = [
      "/bin/harness-telegram"
      "/etc/harness-remote/config.json"
    ];
    Env = [
      "PATH=/bin"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "LANG=C.UTF-8"
      "TZDIR=${pkgs.tzdata}/share/zoneinfo"
    ];
    ExposedPorts."8080/tcp" = { };
  };
}
