// The hub's network access: a paired device reaches it and runs a turn there; an unknown or a
// revoked device token is refused; the hub serves the app, and a pairing link opens it as the
// user's device.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { HubConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { wsTransport } from "#client/ws-transport.ts";
import { HubAuth } from "#hub/auth.ts";
import { listenWs } from "#hub/endpoints/ws.ts";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";
import { WebDriver } from "#testkit/drivers/web.ts";
import { bundledBrowser } from "#testkit/capture/rasterize.ts";
import { appWebDir, serveStatic } from "#hub/endpoints/static.ts";
import { pairingLink, redeemPairing } from "#cli/admin.ts";

describe("network access", () => {
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

  test("a paired device runs a turn on the hub; unknown and revoked tokens are refused", async () => {
    const stand = await createStand({ name: "work" });
    stands.push(stand);
    stand.script([{ toolCalls: [{ name: "bash", args: { command: "echo on-work" } }] }, { text: "done" }]);

    const auth = new HubAuth(stand.dataDir);
    const code = auth.addPairing("laptop", Date.now());
    const server = await listenWs(stand.hub, auth, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { device, token } = await redeemPairing(url, code);
    assert.equal(device, "laptop");

    const client = new ClientModel();
    const connection = await HubConnection.open(await wsTransport(url), "test", token);
    cleanups.push(() => connection.close());
    await client.addConnection(connection, { home: true });
    const api = client.connection("work");
    const { agent } = await api.request("agent_start", { cwd: stand.project });
    await api.request("agent_attach", { agent: agent.id, level: "full" });
    const ended = nextRecord(connection, agent.id, (record) => record.type === "tool_execution_end");
    await api.call(agent.id, { type: "harness_prompt", text: "go", mode: "plan" });
    assert.match(JSON.stringify((await ended).result), /on-work/);

    await assert.rejects(HubConnection.open(await wsTransport(url), "test", "not-a-token"), /unknown device token/);
    auth.revokeDevice("laptop");
    await assert.rejects(HubConnection.open(await wsTransport(url), "test", token), /unknown device token/);
  });

  test("the hub serves the app: a pairing link opens it as the user's device", { skip: WebDriver.available() }, async () => {
    const stand = await createStand({ name: "home" });
    stands.push(stand);
    const auth = new HubAuth(stand.dataDir);
    const code = auth.addPairing("browser", Date.now());
    const server = await listenWs(stand.hub, auth, { host: "127.0.0.1", port: 0, http: serveStatic(appWebDir() ?? "") });
    cleanups.push(() => server.close());
    const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: bundledBrowser(), args: ["--no-sandbox"] });
    cleanups.push(() => void browser.close());
    const page = await browser.newPage();
    await page.goto(pairingLink(`http://${base}`, code));
    // the code left the address and became this browser's device
    await page.getByRole("button", { name: "New session" }).first().waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).hash, "");
    await page.getByRole("button", { name: "New session" }).first().click();
    // choosing the folder: `~` browses the hub's home, Enter on `· this folder` starts there
    await page.getByRole("list", { name: "new session folder" }).waitFor();
    await page.keyboard.press("~");
    await page.getByText("· this folder").waitFor();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    const local = await stand.connect();
    for (let tries = 0; (await local.request("agents_list", {})).agents.length === 0; tries += 1) {
      assert.ok(tries < 400, "no agent started on the hub");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      auth.devices().map((device) => device.name),
      ["browser"],
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
