import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FAILURES_PER_ADDRESS, FAILURES_PER_CODE, HubAuth, PAIRING_TTL_MS } from "./auth.ts";
import { parseListen } from "./config.ts";
import { networkProblem } from "./network.ts";

const NOW = 1_000_000;

test("devices: tokens are shown once and kept as hashes; names stay unique; a revoked device is unknown", () => {
  const home = mkdtempSync(join(tmpdir(), "auth-"));
  const auth = new HubAuth(home);
  const { device, token } = auth.addDevice("Chrome on macOS", NOW);

  assert.equal(device, "Chrome on macOS");
  assert.equal(auth.deviceOfToken(token, NOW + 5, "10.0.0.9"), "Chrome on macOS");
  assert.deepEqual(auth.devices(), [{ name: "Chrome on macOS", created: NOW, lastSeen: NOW + 5, address: "10.0.0.9" }]);
  assert.throws(() => auth.deviceOfToken("nope", NOW, "x"), /unknown device token/);
  assert.throws(() => auth.addDevice("  ", NOW), /printable/);
  assert.equal(auth.addDevice("Chrome on macOS", NOW).device, "Chrome on macOS 2", "a name taken gets a number");

  const stored = readFileSync(join(home, "hub", "devices.json"), "utf8");
  assert.equal(stored.includes(token), false, "no secret in clear");
  assert.equal(statSync(join(home, "hub", "devices.json")).mode & 0o077, 0);

  auth.renameDevice("Chrome on macOS", "laptop");
  assert.throws(() => auth.renameDevice("laptop", "Chrome on macOS 2"), /named .* already/);
  auth.revokeDevice("laptop");
  assert.throws(() => auth.deviceOfToken(token, NOW, "x"), /unknown device token/);
});

test("pairing codes: once, within their time, typed loosely; the device appears only when one is redeemed", () => {
  const home = mkdtempSync(join(tmpdir(), "auth-"));
  const auth = new HubAuth(home);
  const { id, code } = auth.addPairing("phone", NOW);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.deepEqual(auth.devices(), []);
  assert.ok(!readFileSync(join(home, "hub", "pairings.json"), "utf8").includes(code.replace(/-/g, "")), "only the code's hash is kept");

  const typed = ` ${code.toLowerCase().replace(/-/g, " ")} `;
  const paired = auth.redeemPairing(typed, NOW + 1000, "a", "ignored: the code has a name");
  assert.deepEqual([paired.device, paired.pairing], ["phone", id]);
  assert.equal(auth.deviceOfToken(paired.token, NOW, "a"), "phone");
  assert.deepEqual(auth.pairings(NOW), [{ id, expires: NOW + PAIRING_TTL_MS, name: "phone", used: "phone" }], "a used code shows by whom");
  assert.throws(() => auth.redeemPairing(code, NOW + 2000, "a"), /unknown pairing code/);

  const unnamed = auth.addPairing(undefined, NOW);
  assert.equal(auth.redeemPairing(unnamed.code, NOW, "b", "Pixel 9").device, "Pixel 9", "the device's own name when the code has none");

  const late = auth.addPairing("tablet", NOW);
  assert.throws(() => auth.redeemPairing(late.code, NOW + PAIRING_TTL_MS, "c"), /expired/);
});

test("guessing is bounded: by address, and the open codes go after too many wrong ones", () => {
  const auth = new HubAuth(mkdtempSync(join(tmpdir(), "auth-")));
  for (let n = 0; n < FAILURES_PER_ADDRESS - 1; n += 1) {
    assert.throws(() => auth.redeemPairing("WRONG-WRONG-WRONG", NOW, "attacker"), /unknown pairing code/);
  }
  const open = auth.addPairing("phone", NOW);
  assert.throws(() => auth.redeemPairing("WRONG-WRONG-WRONG", NOW, "attacker"), /unknown pairing code/);
  assert.throws(() => auth.redeemPairing(open.code, NOW, "attacker"), /too many wrong pairing codes/, "the right code too, from that address");
  assert.equal(auth.redeemPairing(open.code, NOW, "someone else").device, "phone");
  assert.throws(() => auth.redeemPairing("x", NOW + PAIRING_TTL_MS, "attacker"), /unknown pairing code/, "the address may try again later");

  const auth2 = new HubAuth(mkdtempSync(join(tmpdir(), "auth-")));
  const target = auth2.addPairing("tablet", NOW);
  for (let n = 0; n < FAILURES_PER_CODE; n += 1) {
    assert.throws(() => auth2.redeemPairing("WRONG-WRONG-WRONG", NOW, `address ${n}`), /unknown pairing code/);
  }
  assert.throws(() => auth2.redeemPairing(target.code, NOW, "owner"), /unknown pairing code/, "withdrawn after too many wrong codes in all");
});

test("listen addresses; off loopback only behind a proxy", () => {
  assert.deepEqual(parseListen("8790"), { host: "127.0.0.1", port: 8790 });
  assert.deepEqual(parseListen(":80"), { host: "0.0.0.0", port: 80 });
  assert.deepEqual(parseListen("10.0.0.1:9"), { host: "10.0.0.1", port: 9 });
  assert.throws(() => parseListen("x"), /host:port/);
  assert.equal(networkProblem({ enabled: true, listen: "127.0.0.1:8790", proxy: false }), undefined);
  assert.match(networkProblem({ enabled: true, listen: "0.0.0.0:8080", proxy: false }) ?? "", /off loopback/);
  assert.equal(networkProblem({ enabled: true, listen: "0.0.0.0:8080", proxy: true }), undefined);
});
