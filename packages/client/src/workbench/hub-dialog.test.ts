// The /hub dialog's model: the main screen's rows from the hub's status; Enter toggles the network
// and applies a field typed; a device opens its screen (rename, revoke); adding a device makes a code
// whose state follows the hub's status (open, used, expired); ← goes back; a service's settings are
// read-only.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubStatus } from "#protocol/hub.ts";
import { HubDialog, type DialogPairing, type HubDialogRow } from "./hub-dialog.ts";

function networkLabel(row: HubDialogRow | undefined): string {
  return row?.kind === "network" ? row.label : "";
}

const NOW = Date.UTC(2026, 10, 27, 12, 0);

function status(change: Partial<HubStatus["network"]> = {}, devices: HubStatus["devices"] = [], pairings: HubStatus["pairings"] = []): HubStatus {
  return { network: { enabled: false, listen: "127.0.0.1:8790", proxy: false, source: "settings", running: false, ...change }, devices, pairings };
}

function dialog(initial: HubStatus) {
  const calls: unknown[][] = [];
  let current = initial;
  let now = NOW;
  const pairing: DialogPairing = { id: "p1", code: "AAAAA-BBBBB-CCCCC", expires: NOW + 600_000, link: "https://hub/#pair=AAAAA-BBBBB-CCCCC", qr: { size: 1, modules: "1" } };
  const made = new HubDialog("local", {
    status: async () => current,
    network: async (change) => {
      calls.push(["network", change]);
      current = status({ ...current.network, ...change, running: change.enabled ?? current.network.enabled }, current.devices, current.pairings);
      return current;
    },
    pair: async (name) => {
      calls.push(["pair", name]);
      current = status(current.network, current.devices, [{ id: "p1", expires: pairing.expires }]);
      return pairing;
    },
    rename: async (name, to) => {
      calls.push(["rename", name, to]);
      return current;
    },
    revoke: async (name) => {
      calls.push(["revoke", name]);
      current = status(current.network, [], current.pairings);
      return current;
    },
    copy: (text) => calls.push(["copy", text]),
    now: () => now,
    changed: () => undefined,
    notify: () => undefined,
    close: () => calls.push(["close"]),
  });
  return { made, calls, setNow: (at: number) => (now = at), set: (next: HubStatus) => (current = next) };
}

test("the main screen: the network toggles, a field typed applies with Enter", async () => {
  const { made, calls } = dialog(status());
  await made.refresh();
  assert.deepEqual(
    made.rows().map((row) => row.kind),
    ["network", "field", "toggle", "field", "action"],
  );
  await made.enter();
  assert.deepEqual(calls.at(-1), ["network", { enabled: true }]);
  assert.match(networkLabel(made.rows()[0]), /network on/);

  made.move(1);
  made.type("127.0.0.1:0");
  const listen = made.rows()[1];
  assert.equal(listen?.kind === "field" ? made.fieldText(listen) : "", "127.0.0.1:0", "the draft shows while typed");
  await made.enter();
  assert.deepEqual(calls.at(-1), ["network", { listen: "127.0.0.1:0" }]);
});

test("a device: its screen renames and revokes; ← goes back", async () => {
  const { made, calls } = dialog(status({}, [{ name: "phone", created: NOW - 3_600_000, lastSeen: NOW - 120_000, address: "100.64.0.2", connected: false }]));
  await made.refresh();
  const device = made.rows().findIndex((row) => row.kind === "device");
  assert.match(JSON.stringify(made.rows()[device]), /seen 2 min ago from 100\.64\.0\.2/);
  made.selected = device;
  await made.enter();
  assert.equal(made.title(), "device phone");
  made.type("my phone");
  await made.enter();
  assert.deepEqual(calls.at(-1), ["rename", "phone", "my phone"]);
  made.move(1);
  await made.enter();
  assert.deepEqual(calls.at(-1), ["revoke", "my phone"]);
  assert.equal(made.screen.kind as string, "main");
  made.back();
  assert.equal(made.screen.kind, "main", "← on the main screen stays");
});

test("adding a device: a code, its link copied, its state from the hub: open, used, expired", async () => {
  const { made, calls, setNow, set } = dialog(status({ enabled: true, running: true, url: "https://hub" }));
  await made.refresh();
  made.selected = made.rows().length - 1;
  await made.enter();
  assert.equal(made.screen.kind as string, "add");
  await made.enter(); // an empty name: the device's own
  assert.deepEqual(calls.at(-1), ["pair", undefined]);
  assert.equal(made.screen.kind as string, "pairing");
  assert.deepEqual(made.pairingState(), { kind: "open", until: `${String(new Date(NOW + 600_000).getHours()).padStart(2, "0")}:${String(new Date(NOW + 600_000).getMinutes()).padStart(2, "0")}` });
  await made.enter(); // copy link
  assert.deepEqual(calls.at(-1), ["copy", "https://hub/#pair=AAAAA-BBBBB-CCCCC"]);

  made.update(status({ enabled: true, running: true, url: "https://hub" }, [], [{ id: "p1", expires: NOW + 600_000, used: "Pixel 9" }]));
  assert.deepEqual(made.pairingState(), { kind: "used", device: "Pixel 9" });
  made.update(status({ enabled: true, running: true }, [], []));
  setNow(NOW + 600_000);
  assert.deepEqual(made.pairingState(), { kind: "expired" });
  set(status({ enabled: true, running: true }));
  made.back();
  assert.equal(made.screen.kind as string, "add");
});

test("a service's network access is read-only", async () => {
  const { made, calls } = dialog(status({ source: "service", enabled: true, running: true }));
  await made.refresh();
  await made.enter();
  assert.equal(calls.length, 0, "nothing changes");
  assert.match(networkLabel(made.rows()[0]), /set by the service/);
});
