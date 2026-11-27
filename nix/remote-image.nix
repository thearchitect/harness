# lib.mkRemoteImage: the OCI image of a user's remote harness hub (Linux, Fly.io).
#
#   harness.lib.mkRemoteImage {
#     pkgs;                 # nixpkgs of the image's system
#     config;               # remote.yaml: the user and their initial settings
#     envs;                 # cage store envs: user-<name>.cage (the agents get its variables)
#     extraPackages ? [ ];  # tools for the agents beyond the image's own
#     name ? "harness-remote";
#     tag ? "latest";
#   }
#
# s6-svscan supervises the user's hub: `harness hub` as the user's own uid (s6-setuidgid) with the
# user's cage env, listening on 8080 behind Fly's TLS proxy. Ten minutes without clients and
# without working agents the hub exits; its finish script then ends s6, so the machine stops, and
# Fly starts it again at the next request. At boot, harness-boot prepares the home on the volume
# (/data/home/<name>) and starts s6. Plaintext secrets never enter the image;
# devices are paired on the machine (`fly ssh console`, `harness hub device add --name <device>`).
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

  # remote.yaml → passwd, group, the hub's s6 service. Built, not evaluated: no IFD.
  etc = pkgs.runCommand "${name}-etc" { nativeBuildInputs = [ pkgs.yq-go pkgs.jq ]; } ''
    mkdir -p $out/etc/harness-remote/envs $out/etc/ssh $out/etc/s6/hub
    yq -o=json '.' ${config} > remote.json
    cp remote.json $out/etc/harness-remote/remote.json
    user=$(jq -r '.user.name' remote.json)
    uid=$(jq -r '.user.uid' remote.json)
    {
      echo "root:x:0:0:root:/root:/bin/bash"
      echo "$user:x:$uid:$uid:$user:/data/home/$user:/bin/bash"
      echo "nobody:x:65534:65534:nobody:/var/empty:/bin/false"
    } > $out/etc/passwd
    {
      echo "root:x:0:"
      echo "$user:x:$uid:"
      echo "nogroup:x:65534:"
    } > $out/etc/group
    echo "hosts: files dns" > $out/etc/nsswitch.conf
    # Agents run git over SSH unattended: trust a host key on first use.
    printf 'Host *\n  StrictHostKeyChecking accept-new\n' > $out/etc/ssh/ssh_config

    # The hub: the user's uid, network access on 8080 (Fly terminates TLS), the user's cage env
    # (decrypted by root's machine identity, then the identity is out of reach of the hub).
    jq -n '{ server: true, network: { listen: "0.0.0.0:8080", proxy: true }, idleExit: 10 }' > $out/etc/harness-remote/hub.json
    # the hub's exit when idle (0) ends the container; hub_restart (75) and failures are restarted
    cat > $out/etc/s6/hub/finish <<EOF
    #!/bin/sh
    if [ "\$1" = 0 ]; then exec ${pkgs.s6}/bin/s6-svscanctl -t /etc/s6; else exit 0; fi
    EOF
    chmod +x $out/etc/s6/hub/finish
    envfile=""
    if [ -f ${envs}/user-$user.cage ]; then
      cp ${envs}/user-$user.cage $out/etc/harness-remote/envs/
      envfile="/etc/harness-remote/envs/user-$user.cage"
    else
      : # the user has no secrets in the deployment
    fi
    {
      echo "#!/bin/sh"
      echo "export HOME=/data/home/$user USER=$user"
      echo "cd \"\$HOME\""
      if [ -n "$envfile" ]; then
        # cage reads the machine identity as root; the hub and its agents never see its path
        echo "exec env CAGE_SSH_IDENTITY=/run/harness/machine-identity ${cage}/bin/cage run -raw -no-mask $envfile - env -u CAGE_SSH_IDENTITY s6-setuidgid $user ${harness} hub --config /etc/harness-remote/hub.json"
      else
        echo "exec s6-setuidgid $user ${harness} hub --config /etc/harness-remote/hub.json"
      fi
    } > $out/etc/s6/hub/run
    chmod +x $out/etc/s6/hub/run
  '';

  # Boot: the user's home on the volume and its initial settings, then s6.
  boot = pkgs.writeShellScriptBin "harness-boot" ''
    set -euo pipefail
    remote=/etc/harness-remote/remote.json
    if [ -e /run/harness/machine-identity ]; then chmod 600 /run/harness/machine-identity; else :; fi
    mkdir -p /data/home && chmod 755 /data/home

    user=$(${pkgs.jq}/bin/jq -r '.user.name' $remote)
    home=/data/home/$user
    mkdir -p $home && chown $user:$user $home && chmod 700 $home
    # the user's initial settings (an existing file is never touched)
    if [ ! -e $home/.harness/settings.json ]; then
      ${pkgs.util-linux}/bin/setpriv --reuid=$user --regid=$user --clear-groups sh -c "umask 077; mkdir -p $home/.harness && cat > $home/.harness/settings.json" \
        < <(${pkgs.jq}/bin/jq '.defaultSettings // {}' $remote)
    else
      : # the user's own settings
    fi
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
