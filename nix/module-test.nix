# The NixOS module in a VM: a hub service for each of two users, one with network access; each
# hub's socket is its user's, and a device pairs with the networked one.
{
  pkgs,
  self,
}:
pkgs.testers.runNixOSTest {
  name = "harness-module";
  nodes.machine =
    { ... }:
    {
      imports = [ self.nixosModules.default ];
      virtualisation.memorySize = 2048;
      environment.systemPackages = [ pkgs.curl ];
      users.users.alice = {
        isNormalUser = true;
      };
      users.users.bob = {
        isNormalUser = true;
      };
      services.harness.hubs = {
        alice = { };
        bob = {
          listen = "127.0.0.1:8790";
          url = "http://127.0.0.1:8790";
        };
      };
    };
  testScript = ''
    machine.wait_for_unit("harness-alice.service")
    machine.wait_for_unit("harness-bob.service")
    machine.wait_until_succeeds("test -S /home/alice/.harness/run/hub.sock")
    machine.wait_until_succeeds("test -S /home/bob/.harness/run/hub.sock")
    machine.succeed("stat -c %U /home/alice/.harness/run/hub.sock | grep -qx alice")
    machine.wait_until_succeeds("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/pair | grep -qx 405")
    code = machine.succeed("su bob -c 'harness hub device add --name phone' | sed -n 2p").strip()
    machine.succeed(f"curl -sf -X POST -H 'content-type: application/json' -d '{{\"code\":\"{code}\"}}' http://127.0.0.1:8790/pair | grep -q '\"device\":\"phone\"'")
  '';
}
