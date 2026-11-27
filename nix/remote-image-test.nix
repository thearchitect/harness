# The remote image in a VM under podman: it boots (the user's home), s6 runs the user's hub as
# that user, the hub serves the app on 8080, and a device pairs with it.
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
    machine.wait_until_succeeds("podman exec remote test -S /data/home/alice/.harness/run/hub.sock", timeout=180)
    # the hub runs as its user
    machine.succeed("podman exec remote ps -eo user:16,args | grep 'harness hub' | grep -v grep | grep -q '^alice '")
    # the hub serves the app's web build (WebSocket paths upgrade)
    machine.wait_until_succeeds("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ | grep -qx 200", timeout=60)
    machine.succeed("curl -s http://127.0.0.1:8080/fonts/jetbrains-mono-regular.woff2 -o /dev/null -w '%{content_type}' | grep -qx font/woff2")
    # a device pairs on the machine's console
    code = machine.succeed("podman exec remote su alice -s /bin/sh -c 'HOME=/data/home/alice harness hub device add --name phone' | sed -n 2p").strip()
    machine.succeed(f"curl -sf -X POST -H 'content-type: application/json' -d '{{\"code\":\"{code}\"}}' http://127.0.0.1:8080/pair | grep -q '\"device\":\"phone\"'")
  '';
}
