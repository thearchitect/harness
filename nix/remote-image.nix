# lib.mkRemoteImage: the OCI image of a remote harness deployment (Linux, Fly.io).
#
#   harness.lib.mkRemoteImage {
#     pkgs;                 # nixpkgs of the image's system
#     config;               # remote.yaml: the hub, the users, their initial settings
#     envs;                 # cage store envs: user-<name>.cage (each user's agents get its variables)
#     extraPackages ? [ ];  # tools for the agents beyond the image's own
#     name ? "harness-remote";
#     tag ? "latest";
#   }
#
# s6-svscan supervises one hub and one node per user: `harness hub` as the service user `harness`
# (listening on 8080 behind Fly's TLS proxy), `harness node` as each user's own uid
# (s6-setuidgid) with the user's cage env, linked to the hub over localhost. At boot,
# harness-boot prepares the homes on the volume (/data/home/<name>), registers the users and
# their nodes at the hub (a node's key is written once, into its user's home), and starts s6.
# Plaintext secrets never enter the image; devices are paired by an admin (`fly ssh console`,
# `harness hub device add <user> --name <device>`).
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
  inherit (bundle.passthru) cage;
  harness = "${bundle}/bin/harness";

  remoteTools = import ./remote-tools.nix pkgs;
  agentTools = remoteTools.tools;
  inherit (remoteTools) nixLdLibraries;

  # remote.yaml → passwd, group, the s6 services and the boot's user list. Built, not
  # evaluated: no IFD.
  etc = pkgs.runCommand "${name}-etc" { nativeBuildInputs = [ pkgs.yq-go pkgs.jq ]; } ''
    mkdir -p $out/etc/harness-remote/envs $out/etc/ssh $out/etc/s6/hub
    yq -o=json '.' ${config} > remote.json
    cp remote.json $out/etc/harness-remote/remote.json
    {
      echo "root:x:0:0:root:/root:/bin/bash"
      echo "harness:x:999:999:harness hub:/data/home/harness:/bin/false"
      jq -r '.users[] | "\(.name):x:\(.uid):\(.uid):\(.name):/data/home/\(.name):/bin/bash"' remote.json
      echo "nobody:x:65534:65534:nobody:/var/empty:/bin/false"
    } > $out/etc/passwd
    {
      echo "root:x:0:"
      echo "harness:x:999:"
      jq -r '.users[] | "\(.name):x:\(.uid):"' remote.json
      echo "nogroup:x:65534:"
    } > $out/etc/group
    echo "hosts: files dns" > $out/etc/nsswitch.conf
    # Agents run git over SSH unattended: trust a host key on first use.
    printf 'Host *\n  StrictHostKeyChecking accept-new\n' > $out/etc/ssh/ssh_config

    # The hub: the service user, the WebSocket endpoint on 8080 (Fly terminates TLS).
    cat > $out/etc/s6/hub/run <<EOF
    #!${pkgs.execline}/bin/execlineb -P
    export HOME /data/home/harness
    s6-setuidgid harness
    ${harness} hub --name hub --listen :8080
    EOF
    chmod +x $out/etc/s6/hub/run

    # A node per user, as the user, with the user's cage env (decrypted by root's machine
    # identity, then the identity is out of reach of the user's processes).
    for user in $(jq -r '.users[].name' remote.json); do
      mkdir -p $out/etc/s6/node-$user
      envfile=""
      if [ -f ${envs}/user-$user.cage ]; then
        cp ${envs}/user-$user.cage $out/etc/harness-remote/envs/
        envfile="/etc/harness-remote/envs/user-$user.cage"
      else
        : # the user has no secrets in the deployment
      fi
      jq -n --arg user "$user" '{ users: [$user], hubs: [{ url: "ws://127.0.0.1:8080", keyFile: "/data/home/\($user)/.harness/nodes/\($user).key" }] }' \
        > $out/etc/harness-remote/node-$user.json
      {
        echo "#!/bin/sh"
        echo "export HOME=/data/home/$user USER=$user"
        echo "cd \"\$HOME\""
        if [ -n "$envfile" ]; then
          # cage reads the machine identity as root; the node and its agents never see its path
          echo "exec env CAGE_SSH_IDENTITY=/run/harness/machine-identity ${cage}/bin/cage run -raw -no-mask $envfile - env -u CAGE_SSH_IDENTITY s6-setuidgid $user ${harness} node --name $user --config /etc/harness-remote/node-$user.json"
        else
          echo "exec s6-setuidgid $user ${harness} node --name $user --config /etc/harness-remote/node-$user.json"
        fi
      } > $out/etc/s6/node-$user/run
      chmod +x $out/etc/s6/node-$user/run
    done
  '';

  # Boot: homes on the volume, the hub's users and nodes (idempotent), then s6.
  boot = pkgs.writeShellScriptBin "harness-boot" ''
    set -euo pipefail
    remote=/etc/harness-remote/remote.json
    if [ -e /run/harness/machine-identity ]; then chmod 600 /run/harness/machine-identity; else :; fi
    mkdir -p /data/home && chmod 755 /data/home
    mkdir -p /data/home/harness && chown harness:harness /data/home/harness && chmod 700 /data/home/harness
    as_hub() { ${pkgs.util-linux}/bin/setpriv --reuid=harness --regid=harness --clear-groups env HOME=/data/home/harness ${harness} "$@"; }

    for user in $(${pkgs.jq}/bin/jq -r '.users[].name' $remote); do
      home=/data/home/$user
      mkdir -p $home && chown $user:$user $home && chmod 700 $home
      # the user's initial settings (an existing file is never touched)
      if [ ! -e $home/.harness/settings.json ]; then
        ${pkgs.util-linux}/bin/setpriv --reuid=$user --regid=$user --clear-groups sh -c "umask 077; mkdir -p $home/.harness && cat > $home/.harness/settings.json" \
          < <(${pkgs.jq}/bin/jq '.defaultSettings // {}' $remote)
      else
        : # the user's own settings
      fi
      admin=$(${pkgs.jq}/bin/jq -r --arg u "$user" '.users[] | select(.name == $u) | .admin // false' $remote)
      if ! as_hub hub user list | cut -f1 -d' ' | grep -qx "$user"; then
        if [ "$admin" = true ]; then as_hub hub user add "$user" --admin; else as_hub hub user add "$user"; fi
      else
        : # registered at an earlier boot
      fi
      key=$home/.harness/nodes/$user.key
      if [ ! -s $key ]; then
        as_hub hub node add "$user" --users "$user" | sed -n 2p \
          | ${pkgs.util-linux}/bin/setpriv --reuid=$user --regid=$user --clear-groups sh -c "umask 077; mkdir -p $home/.harness/nodes && cat > $key"
      else
        : # the node's key from an earlier boot
      fi
    done
    exec ${pkgs.s6}/bin/s6-svscan /etc/s6
  '';
in
pkgs.dockerTools.streamLayeredImage {
  inherit name tag;
  contents = [
    etc
    boot
    bundle
    cage
  ]
  ++ (with pkgs; [
    s6
    execline
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
    util-linux
    less
    git
    openssh
    curl
    jq
    cacert
    tzdata
  ])
  ++ agentTools
  ++ extraPackages;
  extraCommands = ''
    mkdir -p tmp root data run/harness usr/bin lib64
    chmod 1777 tmp
    ln -sf ${pkgs.coreutils}/bin/env usr/bin/env
    ln -sf ${pkgs.nix-ld}/libexec/nix-ld lib64/ld-linux-x86-64.so.2
  '';
  config = {
    Cmd = [ "/bin/harness-boot" ];
    Env = [
      "PATH=/bin"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "LANG=C.UTF-8"
      "TZDIR=${pkgs.tzdata}/share/zoneinfo"
      "NIX_LD=${pkgs.stdenv.cc.bintools.dynamicLinker}"
      "NIX_LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath nixLdLibraries}"
      # mise installs prebuilt runtimes, never builds them from source
      "MISE_NODE_COMPILE=0"
      "MISE_PYTHON_COMPILE=0"
      "HARNESS_REVISION=${self.shortRev or self.dirtyShortRev or "unknown"}"
    ];
    ExposedPorts."8080/tcp" = { };
  };
}
