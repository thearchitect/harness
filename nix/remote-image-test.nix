# The remote image in a VM under podman: it boots (homes, the hub's users and node keys), s6
# runs the hub as `harness` and alice's node as alice, the node links to the hub, and the hub
# answers on 8080.
{
  pkgs,
  image,
}:
pkgs.testers.runNixOSTest {
  name = "harness-remote-image";
  nodes.machine =
    { ... }:
    {
      virtualisation.memorySize = 4096;
      # the image (~6 GB) twice: the stream podman reads and the unpacked layers
      virtualisation.diskSize = 40960;
      virtualisation.podman.enable = true;
      environment.systemPackages = [ pkgs.curl ];
    };
  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.succeed("${image} | podman load")
    machine.succeed("mkdir -p /srv/data")
    machine.succeed("podman run -d --name remote -p 8080:8080 -v /srv/data:/data harness-remote:check")
    machine.wait_until_succeeds("podman exec remote test -s /data/home/alice/.harness/nodes/alice.key", timeout=180)
    machine.succeed("podman exec remote stat -c %U /data/home/alice/.harness/nodes/alice.key | grep -qx alice")
    # alice's node links to the hub over localhost
    machine.wait_until_succeeds("podman logs remote 2>&1 | grep -q 'hub ws://127.0.0.1:8080: connected'", timeout=180)
    # each node runs as its user
    machine.succeed("podman exec remote ps -eo user:16,args | grep 'node --name alice' | grep -v grep | grep -q '^alice '")
    machine.succeed("podman exec remote ps -eo user:16,args | grep 'hub --name hub' | grep -v grep | grep -q '^harness '")
    # the hub serves the app's web build (WebSocket paths upgrade)
    machine.succeed("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ | grep -qx 200")
    machine.succeed("curl -s http://127.0.0.1:8080/fonts/jetbrains-mono-regular.woff2 -o /dev/null -w '%{content_type}' | grep -qx font/woff2")
  '';
}
