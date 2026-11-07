/**
 * Tests with real processes and sockets: the RPC client against a fake pi,
 * the webhook endpoint, the user's cage store (the bundle's cage), the login
 * helper (pi's ModelRuntime).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, piSpec, prepareUser, publicKey, runAsUser } from "../accounts.ts";
import type { Config } from "../config.ts";
import { LoginRun } from "../login.ts";
import { RpcProcess, type RpcEvent } from "../rpc.ts";
import { startWebhookServer } from "../server.ts";
import { listSecrets, removeSecret, setSecret } from "../secrets.ts";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));
const manifest = JSON.parse(readFileSync(process.env.HARNESS_MANIFEST ?? "", "utf8")) as { bin: Record<string, string> };

function waitFor<T>(list: T[], predicate: (item: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const check = (): void => {
      const found = list.find(predicate);
      if (found !== undefined) resolve(found);
      else setImmediate(check);
    };
    check();
  });
}

describe("rpc client", () => {
  test("framing, responses, events, dialogs, explicit environment, orderly close", async () => {
    const events: RpcEvent[] = [];
    const ui: { id: string }[] = [];
    const proc = new RpcProcess(
      { command: process.execPath, args: [FAKE_PI], cwd: tmpdir(), env: { ONLY_THIS: "yes" } },
      { onEvent: (e) => events.push(e), onUiRequest: (r) => ui.push(r), onLog: () => undefined },
    );
    const state = await proc.request({ type: "get_state" });
    assert.deepEqual((state as { data: unknown }).data, { cwd: tmpdir(), env: "yes" });
    const unknown = await proc.request({ type: "get_commands" });
    assert.equal(unknown.success, false);
    await proc.request({ type: "prompt", message: "hi" });
    const delta = await waitFor(events, (e) => e.type === "message_update");
    assert.equal((delta as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta, "a\u2028b\u2029c", "U+2028/2029 are not record boundaries; CR is stripped");
    await waitFor(ui, () => true);
    proc.respondUi({ type: "extension_ui_response", id: "ui1", value: "y" });
    const settled = await waitFor(events, (e) => e.type === "agent_settled");
    assert.equal((settled as unknown as { picked: string }).picked, "y");
    proc.close();
    assert.deepEqual(await proc.exited, { code: 0, signal: null });
  });

  test("an exit rejects pending requests and keeps the stderr tail", async () => {
    const proc = new RpcProcess(
      { command: process.execPath, args: [FAKE_PI], cwd: tmpdir(), env: {} },
      { onEvent: () => undefined, onUiRequest: () => undefined, onLog: () => undefined },
    );
    await assert.rejects(proc.request({ type: "prompt", message: "crash" }), /pi exited \(code 3/);
    assert.deepEqual(proc.stderrTail(), ["fatal: crashed on purpose"]);
    await assert.rejects(proc.request({ type: "get_state" }), /pi has exited/);
  });
});

describe("webhook endpoint", () => {
  test("only POST /telegram with the secret is accepted", async () => {
    const updates: unknown[] = [];
    const server = await startWebhookServer({ port: 0, path: "/telegram", secret: "s3cret", onUpdate: (u) => updates.push(u), log: () => undefined });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, secret?: string): Promise<number> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: secret !== undefined ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {},
        body: JSON.stringify({ update_id: 1 }),
      }).then((r) => r.status);
    assert.equal(await post("/telegram"), 401);
    assert.equal(await post("/telegram", "wrong!"), 401);
    assert.equal(await post("/other", "s3cret"), 404);
    assert.equal((await fetch(`${base}/telegram`)).status, 405);
    assert.deepEqual(updates, []);
    assert.equal(await post("/telegram", "s3cret"), 200);
    assert.deepEqual(updates, [{ update_id: 1 }]);
    server.close();
  });
});

describe("accounts, secrets and login (runAs self)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-remote-"));
  after(() => rmSync(dataDir, { recursive: true, force: true }));
  const user = { name: "tester", telegramId: 1, uid: 1000, gid: 1000, git: { name: "T", email: "t@x" }, publicKeys: [] };
  const config: Config = {
    telegram: { tokenVariable: "T", webhookSecretVariable: "W", publicUrl: "https://x/telegram", listenPort: 1 },
    runAs: "self",
    dataDir,
    paths: { pi: "/bin/pi", cage: manifest.bin.cage ?? "", envsDir: join(dataDir, "envs"), machineIdentity: "" },
    users: [user],
    limits: { sessionsPerUser: 1, sessionsTotal: 1, idleMinutes: 1, idleShutdownMinutes: 1 },
    defaultSettings: { defaultProvider: "deepseek" },
  };

  test("prepareUser: home 0700, server key, settings seeded once", async () => {
    assert.deepEqual(await prepareUser(config, user), []);
    const home = homeOf(config, user);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.match((await publicKey(config, user)) ?? "", /^ssh-ed25519 \S+ tester@/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8")), { defaultProvider: "deepseek" });
    await runAsUser(config, user, "sh", ["-c", "echo '{}' > .pi/agent/settings.json"]);
    assert.deepEqual(await prepareUser(config, user), []);
    assert.equal(readFileSync(join(home, ".pi/agent/settings.json"), "utf8"), "{}\n", "an existing settings file is kept");
  });

  test("secrets: set (value through stdin only), list names, run pi through cage, remove", async () => {
    const key = (await publicKey(config, user)) ?? "";
    assert.deepEqual(piSpec(config, user, "/w", "sid").command, "/bin/pi", "no secrets: pi directly");
    assert.deepEqual(await setSecret(config, user, key, "DEEPSEEK_API_KEY", "sk-test\n"), { ok: true });
    assert.deepEqual(await setSecret(config, user, key, "bad name", "x"), { ok: false, problem: "invalid name bad name: use A-Z, 0-9 and _" });
    assert.deepEqual(await listSecrets(config, user), { names: ["DEEPSEEK_API_KEY"] });
    const spec = piSpec(config, user, "/w", "sid");
    assert.equal(spec.command, config.paths.cage);
    assert.deepEqual(spec.args.slice(0, 3), ["run", "-raw", "-no-mask"]);
    assert.deepEqual(spec.args.slice(-6), ["-", "/bin/pi", "--mode", "rpc", "--session-id", "sid"]);
    const run = await runAsUser(config, user, config.paths.cage, [...spec.args.slice(0, -5), "sh", "-c", 'test "$DEEPSEEK_API_KEY" = sk-test']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(await removeSecret(config, user, "DEEPSEEK_API_KEY"), { ok: true });
    assert.deepEqual(await listSecrets(config, user), { names: [] });
  });

  test("login helper lists the OAuth providers of pi", async () => {
    const run = new LoginRun(config, user, ["list"], { prompt: () => Promise.reject(new Error("none")), notify: () => undefined });
    const result = await run.result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.ok && (result.providers ?? []).some((p) => p.id === "openai-codex" && !p.loggedIn));
  });
});
