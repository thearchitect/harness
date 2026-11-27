// Reaching a hub from elsewhere: over the network (behind a TLS proxy) a device pairs once by a
// one-time code and runs a turn; revoking it closes its connection at once; the hub refuses an
// address off loopback without a proxy; a browser opening a pairing link is in at once, its token
// an HttpOnly cookie; over SSH `harness hub attach` joins a client to the running hub and says so
// when none runs.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HubConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { wsTransport } from "#client/ws-transport.ts";
import { sshTransport } from "#hub/endpoints/transports.ts";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";
import { WebDriver } from "#testkit/drivers/web.ts";
import { bundledBrowser } from "#testkit/capture/rasterize.ts";
import { redeemPairing } from "#cli/admin.ts";

const MAIN = fileURLToPath(new URL("../../packages/cli/src/main.ts", import.meta.url));

/** The stand's hub with its network on (a free port on loopback): its http base. */
async function networkOn(stand: Stand, client: HubConnection): Promise<string> {
  await client.request("hub_network_set", { enabled: true, listen: "127.0.0.1:0", url: "http://placeholder" });
  const address = stand.hub.network.address();
  assert.ok(address !== undefined, `the network did not start: ${JSON.stringify(stand.hub.network.status())}`);
  await client.request("hub_network_set", { url: `http://127.0.0.1:${address.port}` });
  return `http://127.0.0.1:${stand.hub.network.address()?.port ?? 0}`;
}

describe("reaching a hub", () => {
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

  test("a paired device runs a turn on the hub; revoking it closes its connection; other tokens are refused", async () => {
    const stand = await createStand({ name: "work" });
    stands.push(stand);
    stand.script([{ toolCalls: [{ name: "bash", args: { command: "echo on-work" } }] }, { text: "done" }]);
    const local = await stand.connect();
    const base = await networkOn(stand, local);

    const pairing = await local.request("device_pair", { name: "laptop" });
    assert.equal(pairing.link, `${base}/#pair=${pairing.code}`);
    const { device, token } = await redeemPairing(base.replace(/^http/, "ws"), pairing.code);
    assert.equal(device, "laptop");
    const status = await local.request("hub_status", {});
    assert.deepEqual(status.pairings.map((open) => open.used), ["laptop"], "the code shows who used it");

    const client = new ClientModel();
    const connection = await HubConnection.open(await wsTransport(base.replace(/^http/, "ws")), "test", token);
    cleanups.push(() => connection.close());
    await client.addConnection(connection, { home: true, name: "work" });
    const api = client.connection("work");
    const { agent } = await api.request("agent_start", { cwd: stand.project });
    await api.request("agent_attach", { agent: agent.id, level: "full" });
    const ended = nextRecord(connection, agent.id, (record) => record.type === "tool_execution_end");
    await api.call(agent.id, { type: "harness_prompt", text: "go", mode: "plan" });
    assert.match(JSON.stringify((await ended).result), /on-work/);
    assert.equal((await local.request("hub_status", {})).devices.find((known) => known.name === "laptop")?.connected, true);

    await assert.rejects(HubConnection.open(await wsTransport(base.replace(/^http/, "ws")), "test", "not-a-token"), /unknown device token/);
    const closed = new Promise<string>((resolve) => connection.onClose(resolve));
    await local.request("device_revoke", { name: "laptop" });
    assert.match(await closed, /./, "its connection closed at once");
    await assert.rejects(HubConnection.open(await wsTransport(base.replace(/^http/, "ws")), "test", token), /unknown device token/);
  });

  test("off loopback the network waits for a proxy; the status says why", async () => {
    const stand = await createStand();
    stands.push(stand);
    const local = await stand.connect();
    const status = await local.request("hub_network_set", { enabled: true, listen: "0.0.0.0:0" });
    assert.equal(status.network.running, false);
    assert.match(status.network.problem ?? "", /off loopback.*TLS proxy/);
    const proxied = await local.request("hub_network_set", { proxy: true });
    assert.equal(proxied.network.running, true);
    const off = await local.request("hub_network_set", { enabled: false });
    assert.equal(off.network.running, false);
  });

  test("a pairing link opens the app as the user's device: its token an HttpOnly cookie, the code spent", { skip: WebDriver.available() }, async () => {
    const stand = await createStand({ name: "home" });
    stands.push(stand);
    const local = await stand.connect();
    const base = await networkOn(stand, local);
    const pairing = await local.request("device_pair", {});
    assert.ok(pairing.link !== undefined);

    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: bundledBrowser(), args: ["--no-sandbox"] });
    cleanups.push(() => void browser.close());
    const page = await browser.newPage();
    await page.goto(pairing.link);
    await page.getByRole("button", { name: "New session" }).first().waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).hash, "", "the code left the address");
    assert.equal(await page.evaluate(() => document.cookie.includes("harness_device")), false, "the page cannot read its token");
    const cookies = await page.context().cookies();
    assert.ok(cookies.some((cookie) => cookie.name === "harness_device" && cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict"));
    assert.equal((await local.request("hub_status", {})).devices.length, 1, "this browser is a device now");

    // the same browser comes back paired; the code is spent
    await page.goto(`${base}/`);
    await page.getByRole("tablist", { name: "sessions" }).waitFor({ timeout: 30_000 });
    await assert.rejects(redeemPairing(base, pairing.code), /unknown pairing code/);
    const other = await browser.newPage();
    await other.goto(pairing.link);
    await other.getByText(/unknown pairing code/).waitFor({ timeout: 15_000 });
  });

  test("over SSH: attach joins the running hub; without one it says so", async () => {
    const stand = await createStand({ name: "default" });
    stands.push(stand);
    stand.script([{ text: "over ssh" }]);
    await stand.connect("unix");
    // an ssh that runs the remote command here (its last argument)
    const bin = mkdtempSync(join(tmpdir(), "ssh-"));
    const ssh = join(bin, "ssh");
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n');
    chmodSync(ssh, 0o755);
    process.env.HARNESS_SSH = ssh;
    process.env.HARNESS_HOME = stand.dataDir;
    const command = `${process.execPath} ${MAIN}`;

    const connection = await HubConnection.open(await sshTransport({ ssh: "me@there", command }), "tui");
    cleanups.push(() => connection.close());
    assert.equal(connection.welcome?.hub, "default");
    const { agents } = await connection.request("agents_list", {});
    assert.deepEqual(agents, []);

    process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "nohub-"));
    await assert.rejects(HubConnection.open(await sshTransport({ ssh: "me@there", command }), "tui"), /no hub runs for .* \(start the service, or open harness there\)/);
    delete process.env.HARNESS_SSH;
    delete process.env.HARNESS_HOME;
  });
});
