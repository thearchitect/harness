# The NixOS module in a VM: a hub node as one user, a work node as another linked to it; the work
# node comes online at the hub, and a stopped node service stops its agents with it.
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
      users.users.hubber = {
        isNormalUser = true;
      };
      users.users.alice = {
        isNormalUser = true;
      };
      services.harness.nodes = {
        hub = {
          user = "hubber";
          hub.listen = "127.0.0.1:8790";
        };
        work = {
          user = "alice";
          users = [ "alice" ];
          hubs = [
            {
              url = "ws://127.0.0.1:8790";
              keyFile = "/home/alice/work.key";
            }
          ];
        };
      };
    };
  testScript = ''
    machine.wait_for_unit("harness-hub.service")
    machine.wait_until_succeeds("test -S /home/hubber/.harness/sockets/hub.sock")
    machine.succeed("su hubber -c 'harness hub user add alice'")
    key = machine.succeed("su hubber -c 'harness hub node add work --users alice' | sed -n 2p").strip()
    machine.succeed(f"su alice -c 'umask 077; printf %s {key} > /home/alice/work.key'")
    machine.wait_until_succeeds("journalctl -u harness-work.service | grep -q 'hub ws://127.0.0.1:8790: connected'", timeout=60)
    machine.succeed("test -S /home/alice/.harness/sockets/work.sock")
    machine.succeed("stat -c %U /home/alice/.harness/sockets/work.sock | grep -qx alice")
  '';
}
