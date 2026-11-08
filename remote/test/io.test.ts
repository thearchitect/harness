/**
 * Tests with real processes and sockets: the RPC client against a fake pi,
 * the HTTP endpoint, the user's cage store (the bundle's cage), the user
 * helper (pi's ModelRuntime and SessionManager).
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { execAsUser, homeOf, piSpec, prepareUser, publicKey, runAsUser } from "../accounts.ts";
import type { Config } from "../config.ts";
import { RpcProcess, type RpcEvent } from "../core/rpc.ts";
import { createHelper } from "../helper.ts";
import { startServer } from "../server.ts";
import { deploymentSecretNames, dropMovedSecrets, listSecrets, removeSecret, setSecret } from "../secrets.ts";
import { FakeClock, FakeTelemetry } from "./fakes.ts";

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

describe("http endpoint", () => {
  test("only POST /telegram with the secret is accepted; the Mini App gets 503 until ready", async () => {
    const updates: unknown[] = [];
    let ready = false;
    const server = await startServer({
      port: 0,
      webhookPath: "/telegram",
      webhookSecret: "s3cret",
      onUpdate: (u) => updates.push(u),
      app: () => (ready ? (_request, response) => response.writeHead(204).end() : undefined),
      t: new FakeTelemetry(),
    });
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
    assert.equal((await fetch(`${base}/app/`)).status, 503);
    ready = true;
    assert.equal((await fetch(`${base}/app/api/state`)).status, 204);
    server.close();
  });
});

describe("accounts, secrets and login (runAs self)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-remote-"));
  after(() => rmSync(dataDir, { recursive: true, force: true }));
  const user = { name: "tester", telegramId: 1, uid: 1000, gid: 1000, git: { name: "T", email: "t@x" }, publicKeys: [], admin: false };
  const config: Config = {
    telegram: { tokenVariable: "T", webhookSecretVariable: "W", publicUrl: "https://x/telegram", listenPort: 1 },
    runAs: "self",
    dataDir,
    paths: { pi: "/bin/pi", cage: manifest.bin.cage ?? "", envsDir: join(dataDir, "envs"), machineIdentity: "" },
    users: [user],
    limits: { sessionsPerUser: 1, sessionsTotal: 1, idleMinutes: 1, idleShutdownMinutes: 1 },
    telemetry: { retentionDays: 30 },
    defaultSettings: { defaultProvider: "deepseek" },
  };

  test("prepareUser: home 0700, server key, settings seeded once", async () => {
    assert.deepEqual(await prepareUser(config, user), []);
    const home = homeOf(config, user);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataDir, "home")).mode & 0o777, 0o755, "users reach their homes");
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

  const clock = new FakeClock();
  const helper = createHelper(config, clock);

  test("user helper: the OAuth providers of pi", async () => {
    const result = await helper.providers(user);
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.data.some((p) => p.id === "openai-codex" && !p.loggedIn));
  });

  test("user helper: sessions and the last turns of one, without thinking and tools", async () => {
    const home = homeOf(config, user);
    const module = import.meta.resolve("@earendil-works/pi-coding-agent");
    const script = `
      const { SessionManager } = await import(${JSON.stringify(module)});
      const s = SessionManager.create(${JSON.stringify(home)});
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const assistant = (content) => ({ role: "assistant", content, api: "x", provider: "x", model: "x", usage, stopReason: "stop", timestamp: Date.now() });
      s.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
      s.appendMessage(assistant([{ type: "thinking", thinking: "hidden" }, { type: "toolCall", id: "t", name: "bash", arguments: {} }]));
      s.appendMessage({ role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: Date.now() });
      s.appendMessage(assistant([{ type: "text", text: "first answer" }]));
      s.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() });
      s.appendMessage(assistant([{ type: "text", text: "second answer" }]));
      process.stdout.write(s.getSessionId());
    `;
    const created = await runAsUser(config, user, process.execPath, ["--input-type=module", "-e", script]);
    assert.equal(created.code, 0, created.stderr);
    const sessionId = created.stdout.trim();
    const sessions = await helper.sessions(user);
    assert.ok(sessions.ok, JSON.stringify(sessions));
    assert.deepEqual(sessions.data.map((s) => [s.id, s.cwd, s.title]), [[sessionId, home, "first question"]]);
    const history = await helper.history(user, home, sessionId, 5);
    assert.deepEqual(history, { ok: true, data: { title: "first question", turns: [{ prompt: "first question", answer: "first answer" }, { prompt: "second", answer: "second answer" }] } });
    assert.deepEqual(await helper.history(user, home, sessionId, 1), { ok: true, data: { title: "first question", turns: [{ prompt: "second", answer: "second answer" }] } });
  });

  test("user helper: a query past its deadline is killed", async () => {
    const pending = helper.sessions(user);
    await clock.advance(30_000);
    assert.deepEqual(await pending, { ok: false, problem: "sessions took longer than 30 s" });
  });

  test("cancelling a login waiting for the user ends its helper", async () => {
    let prompted!: () => void;
    const asked = new Promise<void>((resolve) => (prompted = resolve));
    const run = helper.login(user, ["login", "openai-codex"], {
      prompt: () => {
        prompted();
        return new Promise<string>(() => undefined); // the user never answers
      },
      notify: () => undefined,
    });
    await asked;
    run.cancel();
    const result = await run.result;
    assert.equal(result.ok, false);
  });

  test("secrets moved to the deployment leave the user's store; the deployment's names are known without their values", async () => {
    const key = (await publicKey(config, user)) ?? "";
    assert.deepEqual(await setSecret(config, user, key, "GH_TOKEN", "ghp_x"), { ok: true });
    assert.deepEqual(await setSecret(config, user, key, "OWN", "mine"), { ok: true });
    assert.deepEqual(await deploymentSecretNames(config, user), { names: [] }, "no deployment file");
    // The deployment's file: an env encrypted to the user's key (as move-secrets.sh makes it).
    mkdirSync(config.paths.envsDir, { recursive: true });
    copyFileSync(join(homeOf(config, user), ".cage", "store", "envs", "harness.cage"), join(config.paths.envsDir, `user-${user.name}.cage`));
    assert.deepEqual(await deploymentSecretNames(config, user), { names: ["GH_TOKEN", "OWN"] });
    assert.deepEqual(await removeSecret(config, user, "OWN"), { ok: true });
    assert.deepEqual(await dropMovedSecrets(config, user), { moved: ["GH_TOKEN"] });
    assert.deepEqual(await listSecrets(config, user), { names: [] });
    rmSync(config.paths.envsDir, { recursive: true, force: true });
  });

  test("user helper: model settings round trip through pi's settings.json (patterns kept)", async () => {
    await runAsUser(config, user, "sh", ["-c", `echo '{"enabledModels":["anthropic/*"]}' > .pi/agent/settings.json`]);
    const saved = await helper.saveModels(user, [{ provider: "deepseek", id: "deepseek-flash", effort: "max" }, { provider: "deepseek", id: "deepseek-v4-pro" }], { provider: "deepseek", id: "deepseek-flash" });
    assert.ok(saved.ok, JSON.stringify(saved));
    const settings = await helper.models(user);
    assert.ok(settings.ok, JSON.stringify(settings));
    assert.deepEqual(settings.data.favorites, [{ provider: "deepseek", id: "deepseek-flash", effort: "max" }, { provider: "deepseek", id: "deepseek-v4-pro" }]);
    assert.deepEqual(settings.data.patterns, ["anthropic/*"]);
    assert.deepEqual(settings.data.default, { provider: "deepseek", id: "deepseek-flash" });
  });

  test("user helper: speech to text streams deltas from the endpoint with the user's OpenAI login", async () => {
    let authorization = "";
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('data: {"type":"transcript.text.delta","delta":"Привет, "}\n\n');
        response.write('data: {"type":"transcript.text.delta","delta":"мир"}\n\n');
        response.end('data: {"type":"transcript.text.done","text":"Привет, мир"}\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.HARNESS_TRANSCRIBE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/transcriptions`;
    try {
      const auth = { "openai-codex": { type: "oauth", access: "tok-1", refresh: "r", expires: Date.now() + 3_600_000, accountId: "acc" } };
      await runAsUser(config, user, "sh", ["-c", "umask 077; cat > .pi/agent/auth.json; printf voice > note.oga"], JSON.stringify(auth));
      const deltas: string[] = [];
      const result = await helper.transcribe(user, join(homeOf(config, user), "note.oga"), (text) => deltas.push(text));
      assert.deepEqual(result, { ok: true, data: "Привет, мир" });
      assert.deepEqual(deltas, ["Привет, ", "мир"]);
      assert.equal(authorization, "Bearer tok-1");
    } finally {
      delete process.env.HARNESS_TRANSCRIBE_URL;
      server.close();
    }
  });

  test("execAsUser: a deadline and an output cap kill the command and say why", async () => {
    const slow = await execAsUser(config, user, "sleep", ["5"], { timeoutMs: 50, maxBytes: 100 });
    assert.equal(slow.problem, "took longer than 0.05 s");
    const big = await execAsUser(config, user, "head", ["-c", "4096", "/dev/zero"], { timeoutMs: 5_000, maxBytes: 1_000 });
    assert.equal(big.problem, "larger than 1000 bytes");
  });
});
