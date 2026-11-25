// A hub routes a user's device to a node that connected out to it: the device lists the node,
// starts an agent there and runs a turn; another user cannot reach it; an unknown device token is
// refused; the node going away shows it offline.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { NodeConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { wsTransport } from "#client/ws-transport.ts";
import { Hub } from "#node/hub.ts";
import { listenWs } from "#node/endpoints/ws.ts";
import { Uplink } from "#node/uplink.ts";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";
import { WebDriver } from "#testkit/drivers/web.ts";
import { bundledBrowser } from "#testkit/capture/rasterize.ts";
import { appWebDir, serveStatic } from "#node/endpoints/static.ts";
import { pairingLink, redeemPairing } from "#cli/admin.ts";

function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("condition not reached"));
      } else {
        // keep waiting
      }
    }, 20);
  });
}

describe("hub", () => {
  const stands: Stand[] = [];
  const cleanups: (() => void)[] = [];
  after(async () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    for (const stand of stands) {
      await stand.down();
    }
  });

  test("a device reaches a node behind the hub, runs a turn there; others cannot; the node going away is offline", async () => {
    const hubStand = await createStand({ name: "hub" });
    const work = await createStand({ name: "work", users: ["alice"] });
    stands.push(hubStand, work);
    work.script([{ toolCalls: [{ name: "bash", args: { command: "echo on-work" } }] }, { text: "done" }]);

    const hub = new Hub(hubStand.node);
    hub.auth.addUser("alice");
    hub.auth.addUser("bob");
    const alice = hub.auth.addDevice("alice", "laptop").token;
    const bob = hub.auth.addDevice("bob", "phone").token;
    const key = hub.auth.addNode("work", ["alice"]).key;
    const server = await listenWs(hubStand.node, hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

    let linked = false;
    const uplink = new Uplink(work.node, { url, key, onState: (state) => (linked = state === "connected") });
    uplink.start();
    cleanups.push(() => uplink.stop());
    await until(() => linked);

    const client = new ClientModel();
    const device = await NodeConnection.open(await wsTransport(url), "test", alice);
    cleanups.push(() => device.close());
    await client.addConnection(device, { home: true });
    assert.ok(client.connections.has("work"), "alice sees the work node");
    assert.equal(client.connections.has("hub"), false, "the hub's own node is not alice's");

    const api = client.connection("work");
    const { agent } = await api.request("agent_start", { cwd: work.project });
    await api.request("agent_attach", { agent: agent.id, level: "full" });
    const ended = nextRecord(device, agent.id, (record) => record.type === "tool_execution_end");
    await api.call(agent.id, { type: "harness_prompt", text: "go", mode: "plan" });
    assert.match(JSON.stringify((await ended).result), /on-work/);

    const bobs = await NodeConnection.open(await wsTransport(url), "test", bob);
    cleanups.push(() => bobs.close());
    await assert.rejects(bobs.request("agents_list", {}, "work"), /may not use node work/);
    await assert.rejects(NodeConnection.open(await wsTransport(url), "test", "not-a-token"), /unknown device token/);

    uplink.stop();
    await until(() => client.offline.has("work"));
  });

  test("the hub serves the app: a pairing link opens it as the user's device, on the user's nodes", { skip: WebDriver.available() }, async () => {
    const hubStand = await createStand({ name: "hub" });
    const home = await createStand({ name: "home", users: ["carol"] });
    stands.push(hubStand, home);
    const hub = new Hub(hubStand.node);
    hub.auth.addUser("carol");
    const code = hub.auth.addPairing("carol", "browser", Date.now());
    const key = hub.auth.addNode("home", ["carol"]).key;
    const server = await listenWs(hubStand.node, hub, { host: "127.0.0.1", port: 0, http: serveStatic(appWebDir() ?? "") });
    cleanups.push(() => server.close());
    const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    let linked = false;
    const uplink = new Uplink(home.node, { url: `ws://${base}`, key, onState: (state) => (linked = state === "connected") });
    uplink.start();
    cleanups.push(() => uplink.stop());
    await until(() => linked);

    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: bundledBrowser(), args: ["--no-sandbox"] });
    cleanups.push(() => void browser.close());
    const page = await browser.newPage();
    await page.goto(pairingLink(`http://${base}`, code));
    // the code left the address and became this browser's device; the app shows carol's node
    await page.getByRole("button", { name: "New session" }).first().waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).hash, "");
    await page.getByRole("button", { name: "New session" }).first().click();
    // the app has no directory of its own: the node's home
    await page.getByRole("button", { name: "~", exact: true }).click();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    // the new session's agent runs on carol's node
    const local = await home.connect();
    for (let tries = 0; (await local.request("agents_list", {})).agents.length === 0; tries += 1) {
      assert.ok(tries < 400, "no agent started on the home node");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      hub.auth.devices().map((device) => `${device.user}/${device.name}`),
      ["carol/browser"],
    );
    // the same browser comes back paired; the code is spent
    await page.goto(`http://${base}/`);
    await page.getByRole("tablist", { name: "sessions" }).waitFor({ timeout: 30_000 });
    await assert.rejects(redeemPairing(`http://${base}`, code), /unknown pairing code/);
    const other = await browser.newPage();
    await other.goto(pairingLink(`http://${base}`, code));
    await other.getByText(/unknown pairing code/).waitFor({ timeout: 15_000 });
  });
});
