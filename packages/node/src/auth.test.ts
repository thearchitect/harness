import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HubAuth, PAIRING_TTL_MS } from "./auth.ts";
import { parseListen } from "./config.ts";

test("devices and nodes: secrets are shown once and kept as hashes; access follows the node's users", () => {
  const home = mkdtempSync(join(tmpdir(), "auth-"));
  const auth = new HubAuth(home);
  auth.addUser("alice");
  auth.addUser("bob");
  const { token } = auth.addDevice("alice", "laptop");
  const { key } = auth.addNode("work", ["alice"]);

  assert.equal(auth.userOfToken(token), "alice");
  assert.equal(auth.nodeOfKey(key).name, "work");
  assert.ok(auth.mayUse("alice", "work"));
  assert.equal(auth.mayUse("bob", "work"), false);
  assert.throws(() => auth.userOfToken("nope"), /unknown device token/);
  assert.throws(() => auth.addDevice("carol", "x"), /no user carol/);
  assert.throws(() => auth.addUser("Bad Name"), /use a-z/);

  const stored = readFileSync(join(home, "hub", "devices.json"), "utf8") + readFileSync(join(home, "hub", "nodes.json"), "utf8");
  assert.equal(stored.includes(token) || stored.includes(key), false, "no secret in clear");
  assert.equal(statSync(join(home, "hub", "devices.json")).mode & 0o077, 0);

  auth.removeUser("alice");
  assert.throws(() => auth.userOfToken(token), /unknown device token/);
  assert.equal(auth.mayUse("alice", "work"), false);
});

test("pairing codes: once, within their time, typed loosely; the device appears only when one is redeemed", () => {
  const home = mkdtempSync(join(tmpdir(), "auth-"));
  const auth = new HubAuth(home);
  auth.addUser("alice");
  const now = 1_000_000;
  const code = auth.addPairing("alice", "phone", now);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.deepEqual(auth.devices(), []);
  assert.ok(!readFileSync(join(home, "hub", "pairings.json"), "utf8").includes(code.replace(/-/g, "")), "only the code's hash is kept");

  const typed = ` ${code.toLowerCase().replace(/-/g, " ")} `;
  const { user, device, token } = auth.redeemPairing(typed, now + 1000);
  assert.deepEqual([user, device], ["alice", "phone"]);
  assert.equal(auth.userOfToken(token), "alice");
  assert.throws(() => auth.redeemPairing(code, now + 2000), /unknown pairing code/);

  const late = auth.addPairing("alice", "tablet", now);
  assert.throws(() => auth.redeemPairing(late, now + PAIRING_TTL_MS), /expired/);
  assert.throws(() => auth.redeemPairing(late, now), /unknown pairing code/, "an expired code is gone");
  assert.throws(() => auth.addPairing("nobody", "x", now), /no user nobody/);

  const first = auth.addPairing("alice", "watch", now);
  const second = auth.addPairing("alice", "watch", now);
  assert.throws(() => auth.redeemPairing(first, now), /unknown pairing code/, "pairing again replaces the code");
  assert.equal(auth.redeemPairing(second, now).device, "watch");
});

test("listen addresses", () => {
  assert.deepEqual(parseListen("8790"), { host: "127.0.0.1", port: 8790 });
  assert.deepEqual(parseListen(":80"), { host: "0.0.0.0", port: 80 });
  assert.deepEqual(parseListen("10.0.0.1:9"), { host: "10.0.0.1", port: 9 });
  assert.throws(() => parseListen("x"), /host:port/);
});
