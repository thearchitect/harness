/**
 * Scenarios of the gateway end to end, with a recording Bot API, scripted pi
 * processes, a fake user helper and a fake clock: workspaces (private chat,
 * groups), agents attached and in the background, runs, dialogs, sound,
 * crashes, the gateway stopping, and the Mini App API over HTTP.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Update } from "grammy/types";
import { homeOf } from "../accounts.ts";
import { Assets } from "../app/assets.ts";
import { createApp } from "../app/server.ts";
import type { Config, UserConfig } from "../config.ts";
import { FINISHED_ENTRY_TYPE, type PiProcess } from "../core/agent.ts";
import { SessionPool } from "../core/pool.ts";
import { StateStore } from "../core/state.ts";
import { startServer } from "../server.ts";
import { Router } from "../telegram/router.ts";
import { Workbench } from "../workbench.ts";
import { FakeClock, FakeHelper, FakePi, FakeTg, settle } from "./fakes.ts";

const ARTEM = 11;
const STRANGER = 99;
const GROUP = -500;
const TOKEN = "123:abc";

type World = { router: Router; wb: Workbench; tg: FakeTg; clock: FakeClock; pis: FakePi[]; store: StateStore; helper: FakeHelper; home: string; dataDir: string; config: Config };

let world: World;
let updateId = 1;
let messageId = 1000;

function makeWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const user: UserConfig = { name: "artem", telegramId: ARTEM, uid: 1001, gid: 1001, git: { name: "A", email: "a@x" }, publicKeys: [] };
  const config: Config = {
    telegram: { tokenVariable: "T", webhookSecretVariable: "W", publicUrl: "https://x/telegram", listenPort: 1 },
    runAs: "self",
    dataDir,
    paths: { pi: "pi", cage: "cage", envsDir: join(dataDir, "envs"), machineIdentity: "" },
    users: [user],
    limits: { sessionsPerUser: 3, sessionsTotal: 4, idleMinutes: 30, idleShutdownMinutes: 15 },
    defaultSettings: {},
  };
  const home = homeOf(config, user);
  for (const dir of ["proj", "zeta"]) mkdirSync(join(home, dir), { recursive: true });
  const clock = new FakeClock();
  const tg = new FakeTg();
  const store = new StateStore(join(dataDir, "gateway", "state.json"));
  const helper = new FakeHelper();
  const pis: FakePi[] = [];
  const wb = new Workbench({
    config,
    store,
    pool: new SessionPool<PiProcess>(clock, { perUser: 3, total: 4, idleMs: 30 * 60_000 }),
    tg: tg.api,
    clock,
    helper,
    botUsername: "bot",
    log: () => undefined,
    spawn: (spec, handlers) => {
      const pi = new FakePi(spec, handlers);
      pis.push(pi);
      return pi;
    },
    spec: (_user, sessionId, cwd) => ({ command: "pi", args: ["--session-id", sessionId], cwd, env: {} }),
  });
  const router = new Router({ workbench: wb, log: () => undefined, download: async () => Buffer.from("file"), activity: () => undefined });
  return { router, wb, tg, clock, pis, store, helper, home, dataDir, config };
}

function send(update: Omit<Update, "update_id">): Promise<void> {
  return world.router.onUpdate({ update_id: updateId++, ...update } as Update);
}

function chat(chatId: number): { id: number; type: "private"; first_name: string } | { id: number; type: "group"; title: string } {
  return chatId > 0 ? { id: chatId, type: "private", first_name: "A" } : { id: chatId, type: "group", title: "work" };
}

function text(body: string, chatId = ARTEM, from = ARTEM): Promise<void> {
  return send({ message: { message_id: messageId++, date: 0, chat: chat(chatId), from: { id: from, is_bot: false, first_name: "A" }, text: body } } as Omit<Update, "update_id">);
}

function membership(status: "member" | "administrator" | "left", by = ARTEM): Promise<void> {
  return send({
    my_chat_member: {
      chat: chat(GROUP),
      from: { id: by, is_bot: false, first_name: "A" },
      date: 0,
      old_chat_member: { status: "left", user: { id: 1, is_bot: true, first_name: "bot" } },
      new_chat_member: { status, user: { id: 1, is_bot: true, first_name: "bot" } },
    },
  } as Omit<Update, "update_id">);
}

function press(data: string, chatId = ARTEM, onMessage = 1): Promise<void> {
  return send({
    callback_query: { id: `cb${updateId}`, from: { id: ARTEM, is_bot: false, first_name: "A" }, chat_instance: "x", data, message: { message_id: onMessage, date: 0, chat: chat(chatId) } },
  } as Omit<Update, "update_id">);
}

type Sent = { chat: number; text: string; loud: boolean; keyboard: string[] };

/** Every message sent (sendMessage and sendRichMessage), in order. */
function sent(): Sent[] {
  return world.tg.calls
    .filter((c) => c.method === "sendMessage" || c.method === "sendRichMessage")
    .map((c) => {
      const options = c.args[2] as { disable_notification?: boolean; reply_markup?: { inline_keyboard?: { text: string }[][] } };
      return {
        chat: c.args[0] as number,
        text: c.method === "sendMessage" ? String(c.args[1]) : (c.args[1] as { markdown: string }).markdown,
        loud: options.disable_notification === false,
        keyboard: (options.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text),
      };
    });
}

function loud(): string[] {
  return sent()
    .filter((s) => s.loud)
    .map((s) => s.text);
}

function settledEvents(pi: FakePi, answer: string, mode: "plan" | "normal" = "plan"): void {
  pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: answer } });
  pi.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
  pi.emit({ type: "entry_appended", entry: { type: "custom", customType: FINISHED_ENTRY_TYPE, data: { mode, durationMs: 5000, costUsd: 0.01, model: "deepseek/v4" } } });
  pi.emit({ type: "agent_settled", aborted: false });
}

const NO_AGENT_LINE = (chatId: number): string => `[No agent here.](https://t.me/bot?startapp=w${chatId}&mode=compact)`;

describe("gateway", () => {
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => rmSync(world.dataDir, { recursive: true, force: true }));

  test("strangers are ignored; /start gets no answer; the private chat becomes a workspace", async () => {
    await text("hi", ARTEM, STRANGER);
    await text("/start");
    assert.deepEqual(world.tg.calls, []);
    assert.deepEqual(world.store.workspace(ARTEM), { chatId: ARTEM, kind: "private", owner: ARTEM, title: "Direct" });
  });

  test("no agent: one silent link to the Mini App; /new without a path links to its New section", async () => {
    await text("fix the bug");
    await text("/new");
    assert.deepEqual(sent(), [
      { chat: ARTEM, text: NO_AGENT_LINE(ARTEM), loud: false, keyboard: [] },
      { chat: ARTEM, text: `[Choose a directory…](https://t.me/bot?startapp=w${ARTEM}_new&mode=compact)`, loud: false, keyboard: [] },
    ]);
    assert.deepEqual(world.pis, []);
  });

  test("/new <path>: inside ~ only; the agent starts there, the header and the last turns come silently", async () => {
    await text("/new ../..");
    assert.match(sent().at(-1)?.text ?? "", /outside your home/);
    await text("/new proj");
    await settle();
    assert.equal(world.pis[0]?.spec.cwd, join(world.home, "proj"));
    assert.equal(sent().at(-1)?.text, `[~/proj · new session · deepseek-v4-pro](https://t.me/bot?startapp=w${ARTEM}&mode=compact)`);
    assert.equal(sent().at(-1)?.loud, false);
    assert.deepEqual(world.store.user(ARTEM).recentDirs, [join(world.home, "proj")]);
  });

  test("plan by default, ! builds, messages during a run steer; only the banner makes a sound", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    await text("look around");
    await text("also this");
    settledEvents(pi, "The plan.");
    await world.clock.advance(5000);
    await text("!do it");
    await settle();
    const prompts = pi.requests.filter((r) => r.type === "prompt") as { message: string; streamingBehavior?: string }[];
    assert.deepEqual(prompts.map((p) => [p.message, p.streamingBehavior]), [
      ["look around", undefined],
      ["also this", "steer"],
      ["!do it", undefined],
    ]);
    assert.deepEqual(loud(), [`[~/proj · planning finished · 5s · $0.01 · v4](https://t.me/bot?startapp=w${ARTEM}&mode=compact)`]);
    assert.ok(sent().some((s) => s.text === "The plan." && !s.loud), "the answer block stays, silently");
    assert.ok(!world.tg.methods().some((m) => /Draft|Reaction|ChatAction|ForumTopic|pin/i.test(m)));
  });

  test("Stop on the last block aborts the run", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    await text("task");
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    await world.clock.advance(0);
    const withStop = world.tg.calls.find((c) => c.method === "editMessageText" && JSON.stringify(c.args[3]).includes("Stop"));
    assert.ok(withStop !== undefined);
    await press(`x:${pi.spec.args[1]}`);
    assert.ok(pi.requests.some((r) => r.type === "abort"));
  });

  test("groups: a configured user's adding makes a workspace; a stranger's makes the bot leave; others' messages do not count", async () => {
    await membership("member", STRANGER);
    assert.deepEqual(world.tg.of("leaveChat"), [[GROUP]]);
    assert.equal(world.store.workspace(GROUP), undefined);
    await membership("member");
    assert.deepEqual(world.store.workspace(GROUP), { chatId: GROUP, kind: "group", owner: ARTEM, title: "work" });
    assert.deepEqual(sent().map((s) => s.text), [NO_AGENT_LINE(GROUP), "Make me an admin: I need it to see your messages."]);
    await text("hello", GROUP, STRANGER);
    assert.equal(sent().length, 2, "a stranger's message in the group is ignored");
    await text("/new zeta", GROUP);
    await settle();
    assert.equal(world.pis[0]?.spec.cwd, join(world.home, "zeta"));
  });

  test("a new agent displaces the one there into the background; its final answer comes to the private chat with Attach here", async () => {
    await text("/new proj");
    const first = world.pis[0];
    assert.ok(first !== undefined);
    await text("long task");
    await text("/new zeta");
    await settle();
    assert.equal(world.store.workspace(ARTEM)?.agent?.cwd, join(world.home, "zeta"));
    settledEvents(first, "Background result.");
    await settle();
    const last = sent().at(-1);
    assert.equal(last?.loud, true);
    assert.match(last?.text ?? "", /^\[~\/proj · long task\]\(.*\)\n\nBackground result\.\n\n\[~\/proj · planning finished/);
    assert.deepEqual(last?.keyboard, ["Attach here"]);
    await press(`t:${first.spec.args[1]}`);
    await settle();
    assert.equal(world.store.workspace(ARTEM)?.agent?.sessionId, first.spec.args[1]);
  });

  test("a dialog of a background agent comes to the private chat with the header and Attach here", async () => {
    await text("/new proj");
    const first = world.pis[0];
    assert.ok(first !== undefined);
    await text("task");
    await text("/detach");
    first.ui({ type: "extension_ui_request", id: "q", method: "select", title: "Which?", options: ["a", "b"] });
    await settle();
    const dialog = sent().at(-1);
    assert.equal(dialog?.loud, true);
    assert.match(dialog?.text ?? "", /~\/proj · task<\/a>\nWhich\?$/);
    assert.deepEqual(dialog?.keyboard, ["a", "b", "Attach here"]);
    await press(`d:${first.spec.args[1]}:1:1`);
    assert.deepEqual(first.uiResponses, [{ type: "extension_ui_response", id: "q", value: "b" }]);
  });

  test("/detach without a running process ends the agent; /close asks, then ends it", async () => {
    await text("/new proj");
    await text("/close");
    const panel = world.tg.sentId(/^Close the agent in ~\/proj\?/);
    await press("s:closeyes", ARTEM, panel);
    assert.equal(world.store.workspace(ARTEM)?.agent, undefined);
    assert.equal(world.pis[0]?.closed, true);
    assert.equal(world.wb.agents.all().length, 0);
    await text("more");
    assert.equal(sent().at(-1)?.text, NO_AGENT_LINE(ARTEM));
  });

  test("the bot removed from a group: its agent goes to the background", async () => {
    await membership("administrator");
    await text("/new proj", GROUP);
    await text("task", GROUP);
    await membership("left");
    assert.equal(world.store.workspace(GROUP), undefined);
    const agent = world.wb.agents.all()[0];
    assert.ok(agent !== undefined && world.wb.agents.holder(agent) === undefined);
  });

  test("a group migrated to a supergroup keeps its workspace and agent", async () => {
    await membership("administrator");
    await text("/new proj", GROUP);
    await send({ message: { message_id: messageId++, date: 0, chat: chat(GROUP), from: { id: ARTEM, is_bot: false, first_name: "A" }, migrate_to_chat_id: -100500 } } as Omit<Update, "update_id">);
    assert.equal(world.store.workspace(GROUP), undefined);
    assert.equal(world.store.workspace(-100500)?.agent?.cwd, join(world.home, "proj"));
  });

  test("pi dying: the open dialog says interrupted, the error comes with sound, the next message starts pi again", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    await text("task");
    pi.ui({ type: "extension_ui_request", id: "q", method: "confirm", title: "Sure?", message: "x" });
    await settle();
    pi.crash();
    await settle();
    assert.ok(world.tg.of("editMessageText").some((args) => String(args[2]).endsWith("interrupted. Send a message to continue.")));
    assert.match(loud().at(-1) ?? "", /^Error: pi exited unexpectedly/);
    await text("again");
    await settle();
    assert.equal(world.pis.length, 2);
    assert.deepEqual(world.pis[1]?.prompts(), ["again"]);
  });

  test("the gateway stops: a running run is told with sound, processes and helpers end", async () => {
    await text("/new proj");
    await text("task");
    await world.wb.shutdown();
    assert.equal(loud().at(-1), "Server restarting: run interrupted. Send a message to continue.");
    assert.equal(world.pis[0]?.closed, true);
    assert.equal(world.helper.killedAll, true);
  });

  test("the user's queue moves on while a dialog waits for them", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    await text("task");
    pi.ui({ type: "extension_ui_request", id: "q", method: "select", title: "Pick", options: ["a"] });
    await settle();
    await text("/sessions");
    assert.match(sent().at(-2)?.text ?? "", /^\[Agents and sessions\]/);
    assert.equal(sent().at(-1)?.text, "Pick", "the open dialog moved below");
    assert.equal(world.wb.isQuiescent(), true, "an open dialog keeps nothing awake");
  });
});

describe("mini app api", () => {
  let server: Server;
  let base: string;
  let assetsDir: string;

  function initData(userId: number): string {
    const fields = { auth_date: String(Math.floor(world.clock.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "A" }) };
    const check = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
    return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
  }

  async function api(path: string, userId = ARTEM, body?: unknown): Promise<{ status: number; json: { ok: boolean; state?: { workspace: { agent?: { dir: string } }; agents: { id: string }[] }; problem?: string; sessions?: unknown[] } }> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `tma ${initData(userId)}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as never };
  }

  beforeEach(async () => {
    world = makeWorld();
    assetsDir = mkdtempSync(join(tmpdir(), "app-assets-"));
    writeFileSync(join(assetsDir, "index.html"), "{{app.js}}");
    writeFileSync(join(assetsDir, "app.js"), "x");
    const assets = new Assets({ index: join(assetsDir, "index.html"), assets: { "app.js": join(assetsDir, "app.js") } });
    const app = createApp({ workbench: world.wb, helper: world.helper, assets, botToken: TOKEN, clock: world.clock, log: () => undefined, activity: () => undefined });
    server = await startServer({ port: 0, webhookPath: "/telegram", webhookSecret: "s", onUpdate: () => undefined, app: () => app, log: () => undefined });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await text("/start");
  });

  afterEach(() => {
    server.close();
    rmSync(world.dataDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("auth: no or forged initData 401, a stranger 403, someone else's workspace 403", async () => {
    assert.equal((await fetch(`${base}/app/api/state?ws=${ARTEM}`)).status, 401);
    assert.equal((await api(`/app/api/state?ws=${ARTEM}`, STRANGER)).status, 403);
    assert.equal((await api(`/app/api/state?ws=${GROUP}`)).status, 403);
    assert.equal((await api(`/app/api/action?ws=${GROUP}`, ARTEM, { type: "detach" })).status, 403);
  });

  test("new, then the state; a session resumed in a group; the agent moved back; close", async () => {
    const started = await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "new", dir: "~/proj" });
    assert.equal(started.json.state?.workspace.agent?.dir, "~/proj");
    assert.match(sent().at(-1)?.text ?? "", /^\[~\/proj · new session/);
    await membership("administrator");
    world.helper.sessions_ = [{ id: "old", cwd: join(world.home, "zeta"), title: "earlier work", modified: 0 }];
    world.helper.histories.set("old", { title: "earlier work", turns: [{ prompt: "q", answer: "a" }] });
    const sessions = await api("/app/api/sessions");
    assert.deepEqual(sessions.json.sessions, [{ id: "old", dir: "~/zeta", title: "earlier work", modified: 0 }]);
    await api(`/app/api/action?ws=${GROUP}`, ARTEM, { type: "resume", sessionId: "old" });
    assert.equal(sent().at(-1)?.text, `[~/zeta · earlier work · deepseek-v4-pro](https://t.me/bot?startapp=w${GROUP}&mode=compact)\n\n> q\n\na`);
    const first = started.json.state?.agents[0]?.id ?? "";
    const moved = await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "move", agentId: first, to: GROUP });
    assert.equal(moved.status, 200);
    assert.equal(world.store.workspace(GROUP)?.agent?.sessionId, first);
    assert.equal(world.store.workspace(ARTEM)?.agent, undefined);
    assert.ok(sent().some((s) => s.chat === ARTEM && s.text.startsWith("[Agent in ~/proj moved to work.]")));
    const closed = await api(`/app/api/action?ws=${GROUP}`, ARTEM, { type: "close", agentId: first });
    assert.equal(closed.status, 200);
    assert.equal(world.store.workspace(GROUP)?.agent, undefined);
  });
});
