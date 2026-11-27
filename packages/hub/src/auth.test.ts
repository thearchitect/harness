import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HubAuth, PAIRING_TTL_MS } from "./auth.ts";
import { parseListen } from "./config.ts";

test("devices: tokens are shown once and kept as hashes; a revoked device is unknown", () => {
  const home = mkdtempSync(join(tmpdir(), "auth-"));
  const auth = new HubAuth(home);
  const { token } = auth.addDevice("laptop");

  assert.equal(auth.deviceOfToken(token), "laptop");
  assert.throws(() => auth.deviceOfToken("nope"), /unknown device token/);
  assert.throws(() => auth.addDevice("Bad Name"), /use a-z/);

  const stored = readFileSync(join(home, "hub", "devices.json"), "utf8");
  assert.equal(stored.includes(token), false, "no secret in clear");
  assert.equal(statSync(join(home, "hub", "devices.json")).mode & 0o077, 0);

  auth.revokeDevice("laptop");
  assert.throws(() => auth.deviceOfToken(token), /unknown device token/);
});

test("pairing codes: once, within their time, typed loosely; the device appears only when one is redeemed", () => {
  const home = mkdtempSync(join(tmpdir(), "auth-"));
  const auth = new HubAuth(home);
  const now = 1_000_000;
  const code = auth.addPairing("phone", now);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.deepEqual(auth.devices(), []);
  assert.ok(!readFileSync(join(home, "hub", "pairings.json"), "utf8").includes(code.replace(/-/g, "")), "only the code's hash is kept");

  const typed = ` ${code.toLowerCase().replace(/-/g, " ")} `;
  const { device, token } = auth.redeemPairing(typed, now + 1000);
  assert.equal(device, "phone");
  assert.equal(auth.deviceOfToken(token), "phone");
  assert.throws(() => auth.redeemPairing(code, now + 2000), /unknown pairing code/);

  const late = auth.addPairing("tablet", now);
  assert.throws(() => auth.redeemPairing(late, now + PAIRING_TTL_MS), /expired/);
  assert.throws(() => auth.redeemPairing(late, now), /unknown pairing code/, "an expired code is gone");

  const first = auth.addPairing("watch", now);
  const second = auth.addPairing("watch", now);
  assert.throws(() => auth.redeemPairing(first, now), /unknown pairing code/, "pairing again replaces the code");
  assert.equal(auth.redeemPairing(second, now).device, "watch");
});

test("listen addresses", () => {
  assert.deepEqual(parseListen("8790"), { host: "127.0.0.1", port: 8790 });
  assert.deepEqual(parseListen(":80"), { host: "0.0.0.0", port: 80 });
  assert.deepEqual(parseListen("10.0.0.1:9"), { host: "10.0.0.1", port: 9 });
  assert.throws(() => parseListen("x"), /host:port/);
});
