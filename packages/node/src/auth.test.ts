import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HubAuth } from "./auth.ts";
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

test("listen addresses", () => {
  assert.deepEqual(parseListen("8790"), { host: "127.0.0.1", port: 8790 });
  assert.deepEqual(parseListen(":80"), { host: "0.0.0.0", port: 80 });
  assert.deepEqual(parseListen("10.0.0.1:9"), { host: "10.0.0.1", port: 9 });
  assert.throws(() => parseListen("x"), /host:port/);
});
