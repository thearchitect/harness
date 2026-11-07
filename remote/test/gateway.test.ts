/**
 * Scenarios of the gateway end to end, with a recording Bot API, scripted pi
 * processes and a fake clock: places with and without an agent, /agent and
 * /close, runs and steering, dialogs, banners, sound, the native stop,
 * deleted topics, crashes.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Update } from "grammy/types";
import { GATE_OPTIONS, GATE_TITLE } from "../../rpc-dialogs.ts";
import { homeOf } from "../accounts.ts";
import { Gateway } from "../bot.ts";
import type { Config, UserConfig } from "../config.ts";
import type { LoginRun } from "../login.ts";
import { SessionPool } from "../pool.ts";
import { FINISHED_ENTRY_TYPE } from "../render.ts";
import type { PiProcess } from "../session.ts";
import { StateStore } from "../state.ts";
import { FakeClock, FakePi, FakeTg, ok, settle } from "./fakes.ts";

const ARTEM = 11;
const STRANGER = 99;
const TOPIC = 7;

type World = { gateway: Gateway; tg: FakeTg; clock: FakeClock; pis: FakePi[]; store: StateStore; home: string; dataDir: string };

let world: World;
let updateId = 1;
let messageId = 1000;

function makeWorld(subdirs: string[]): World {
  const dataDir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const user: UserConfig = { name: "artem", telegramId: ARTEM, uid: 1001, gid: 1001, git: { name: "A", email: "a@x" }, publicKeys: [] };
  const config: Config = {
    telegram: { tokenVariable: "T", webhookSecretVariable: "W", publicUrl: "https://x/telegram", listenPort: 1 },
    runAs: "self",
    dataDir,
    paths: { pi: "pi", cage: "cage", envsDir: join(dataDir, "envs"), machineIdentity: "" },
    users: [user],
    limits: { sessionsPerUser: 2, sessionsTotal: 4, idleMinutes: 30, idleShutdownMinutes: 15 },
    defaultSettings: {},
  };
  const home = homeOf(config, user);
  mkdirSync(home, { recursive: true });
  for (const dir of subdirs) mkdirSync(join(home, dir), { recursive: true });
  const clock = new FakeClock();
  const tg = new FakeTg();
  const store = new StateStore(join(dataDir, "gateway", "state.json"));
  const pis: FakePi[] = [];
  let draft = 1;
  const gateway = new Gateway({
    config,
    store,
    pool: new SessionPool<PiProcess>(clock, { perUser: 2, total: 4, idleMs: 30 * 60_000 }),
    tg: tg.api,
    clock,
    log: () => undefined,
    spawn: (spec, handlers) => {
      const pi = new FakePi(spec, handlers);
      pis.push(pi);
      return pi;
    },
    spec: (_user, agent) => ({ command: "pi", args: ["--session-id", agent.sessionId], cwd: agent.cwd, env: {} }),
    newDraftId: () => draft++,
    startLogin: () => ({ result: Promise.resolve({ ok: true, providers: [] }), cancel: () => undefined }) as unknown as LoginRun,
    download: async () => Buffer.from("file"),
    activity: () => undefined,
  });
  return { gateway, tg, clock, pis, store, home, dataDir };
}

function send(update: Omit<Update, "update_id">): Promise<void> {
  return world.gateway.onUpdate({ update_id: updateId++, ...update } as Update);
}

function text(body: string, threadId?: number, from = ARTEM): Promise<void> {
  return send({
    message: {
      message_id: messageId++,
      date: 0,
      chat: { id: from, type: "private", first_name: "A" },
      from: { id: from, is_bot: false, first_name: "A" },
      text: body,
      ...(threadId !== undefined ? { message_thread_id: threadId, is_topic_message: true } : {}),
    },
  } as Omit<Update, "update_id">);
}

function topicCreated(threadId: number): Promise<void> {
  return send({
    message: {
      message_id: threadId,
      date: 0,
      chat: { id: ARTEM, type: "private", first_name: "A" },
      from: { id: ARTEM, is_bot: false, first_name: "A" },
      message_thread_id: threadId,
      is_topic_message: true,
      forum_topic_created: { name: "work", icon_color: 0 },
    },
  } as Omit<Update, "update_id">);
}

function press(data: string, threadId: number | undefined, onMessage: number | undefined): Promise<void> {
  return send({
    callback_query: {
      id: `cb${updateId}`,
      from: { id: ARTEM, is_bot: false, first_name: "A" },
      chat_instance: "x",
      data,
      message: {
        message_id: onMessage ?? 1,
        date: 0,
        chat: { id: ARTEM, type: "private", first_name: "A" },
        ...(threadId !== undefined ? { message_thread_id: threadId, is_topic_message: true } : {}),
      },
    },
  } as Omit<Update, "update_id">);
}

function toasts(): string[] {
  return world.tg.of("answerCallbackQuery").map((args) => (args[1] as { text: string }).text);
}

function sentTexts(): string[] {
  return world.tg.of("sendMessage").map((args) => String(args[1]));
}

/** Every message sent with sound: its text. */
function loud(): string[] {
  return world.tg.calls
    .filter((c) => (c.method === "sendMessage" || c.method === "sendRichMessage") && (c.args[2] as { disable_notification?: boolean }).disable_notification === false)
    .map((c) => (c.method === "sendMessage" ? String(c.args[1]) : (c.args[1] as { markdown: string }).markdown));
}

/** /agent proj in the topic; returns its pi. */
async function agentInTopic(): Promise<FakePi> {
  await text("/agent proj", TOPIC);
  await settle();
  const pi = world.pis.at(-1);
  assert.ok(pi !== undefined);
  return pi;
}

describe("gateway", () => {
  beforeEach(() => {
    world = makeWorld(["proj", "zeta", ".hidden"]);
  });
  afterEach(() => rmSync(world.dataDir, { recursive: true, force: true }));

  test("strangers are ignored; topic creation and /start get no answer", async () => {
    await text("hi", undefined, STRANGER);
    await topicCreated(TOPIC);
    await text("/start");
    assert.deepEqual(world.tg.calls, []);
  });

  test("a place without an agent: one silent line; no topic is ever created, renamed or deleted", async () => {
    await text("fix the bug", TOPIC);
    await text("fix the bug");
    assert.deepEqual(sentTexts(), ["No agent here. /agent [path] starts one.", "No agent here. /agent [path] starts one."]);
    assert.deepEqual(loud(), []);
    assert.deepEqual(world.pis, []);
    assert.ok(!world.tg.methods().some((m) => /ForumTopic|copyMessage|Reaction|ChatAction/.test(m)));
  });

  test("/agent without a path: directories at the bottom, one tap starts the agent and pins its status", async () => {
    await text("/agent", TOPIC);
    const panel = world.tg.sentId(/Directory/);
    const buttons = (world.tg.of("sendMessage").at(-1)?.[2] as { reply_markup: { inline_keyboard: { text: string }[][] } }).reply_markup.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ["~", "~/proj", "~/zeta", "Cancel"]);
    await press("p:1", TOPIC, panel);
    await settle();
    assert.equal(world.store.agent(ARTEM, TOPIC)?.cwd, join(world.home, "proj"));
    assert.equal(world.pis[0]?.spec.cwd, join(world.home, "proj"));
    assert.equal(world.tg.of("pinChatMessage").length, 1);
    assert.match(String(world.tg.of("editMessageText").at(-1)?.[2]), /^~\/proj · deepseek-v4-pro · high · idle$/);
    assert.deepEqual(world.store.user(ARTEM).recentDirs, [join(world.home, "proj")]);
    assert.deepEqual(world.tg.of("editForumTopic"), []);
  });

  test("/agent with a path: inside ~ only; a second /agent in the same place is refused", async () => {
    await text("/agent ../..", TOPIC);
    assert.match(sentTexts().at(-1) ?? "", /outside your home/);
    await agentInTopic();
    await text("/agent zeta", TOPIC);
    assert.match(sentTexts().at(-1) ?? "", /already running here \(~\/proj\)/);
    assert.equal(world.pis.length, 1);
  });

  test("plan by default, ! builds, messages during a run steer; nothing but the final message makes a sound", async () => {
    const pi = await agentInTopic();
    await text("look around", TOPIC);
    await text("also this", TOPIC);
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "The plan." } });
    pi.emit({ type: "entry_appended", entry: { type: "custom", customType: FINISHED_ENTRY_TYPE, data: { mode: "plan", durationMs: 5000, costUsd: 0.01, model: "deepseek/v4" } } });
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    await text("!do it", TOPIC);
    await world.clock.advance(0);
    const prompts = pi.requests.filter((r) => r.type === "prompt") as { message: string; streamingBehavior?: string }[];
    assert.deepEqual(prompts.map((p) => [p.message, p.streamingBehavior]), [
      ["look around", undefined],
      ["also this", "steer"],
      ["!do it", undefined],
    ]);
    assert.deepEqual(loud(), ["The plan.\n\nplanning finished · 5s · $0.01 · v4"]);
    assert.ok(!world.tg.methods().some((m) => /Reaction|ChatAction/.test(m)));
    const draft = world.tg.of("sendRichMessageDraft").at(-1)?.[2] as { markdown: string };
    assert.match(draft.markdown, /^\*\*Building · 0s\*\*/);
  });

  test("the gate dialog comes with sound; a text instead of a button rejects with that comment", async () => {
    const pi = await agentInTopic();
    await text("task", TOPIC);
    pi.ui({ type: "extension_ui_request", id: "g", method: "select", title: `${GATE_TITLE}\nedit x`, options: Object.values(GATE_OPTIONS) });
    await settle();
    assert.deepEqual(loud(), ["<b>Allow file change?</b>\n<pre>edit x</pre>"]);
    assert.equal(world.gateway.isQuiescent(), false);
    await text("wrong file", TOPIC);
    pi.ui({ type: "extension_ui_request", id: "c", method: "input", title: "Why reject? Required — the model sees this comment." });
    await settle();
    assert.deepEqual(pi.uiResponses, [
      { type: "extension_ui_response", id: "g", value: "Reject with comment" },
      { type: "extension_ui_response", id: "c", value: "wrong file" },
    ]);
  });

  test("/model: a panel at the bottom, the choice replaces it", async () => {
    const pi = await agentInTopic();
    const respond = pi.respond;
    pi.respond = (command) =>
      command.type === "get_available_models" ? ok("get_available_models", { models: [{ provider: "deepseek", id: "deepseek-flash" }, { provider: "deepseek", id: "deepseek-v4-pro" }] }) : respond(command);
    await text("/model", TOPIC);
    const panel = world.tg.sentId(/^Model/);
    await press("s:model:0", TOPIC, 1);
    assert.equal(toasts().at(-1), "This panel is closed.", "a stale panel does nothing");
    await press("s:model:0", TOPIC, panel);
    assert.deepEqual(pi.requests.at(-1), { type: "set_model", provider: "deepseek", modelId: "deepseek-flash" });
    assert.equal(world.tg.of("editMessageText").filter((args) => args[1] === panel).at(-1)?.[2], "Model: deepseek/deepseek-flash");
  });

  test("agent commands without an agent; account commands anywhere", async () => {
    await text("/model", TOPIC);
    assert.equal(sentTexts().at(-1), "No agent here. /agent [path] starts one.");
    await text("/sessions", TOPIC);
    assert.equal(sentTexts().at(-1), "No agents.");
  });

  test("the draft's native stop aborts the run", async () => {
    const pi = await agentInTopic();
    await text("task", TOPIC);
    await send({ stopped_message_generation: { chat: { id: ARTEM, type: "private", first_name: "A" }, message_thread_id: TOPIC, draft_id: 1 } } as Omit<Update, "update_id">);
    assert.ok(pi.requests.some((r) => r.type === "abort"));
  });

  test("/close: the process stops, the status line is unpinned, the place is free for another /agent", async () => {
    const pi = await agentInTopic();
    await text("/close", TOPIC);
    const panel = world.tg.sentId(/^Close the agent/);
    await press("s:closeyes", TOPIC, panel);
    assert.equal(pi.closed, true);
    assert.equal(world.store.agent(ARTEM, TOPIC), undefined);
    assert.equal(world.tg.of("unpinChatMessage").length, 1);
    await text("more", TOPIC);
    assert.equal(sentTexts().at(-1), "No agent here. /agent [path] starts one.");
    await text("/agent zeta", TOPIC);
    await settle();
    assert.equal(world.store.agent(ARTEM, TOPIC)?.cwd, join(world.home, "zeta"));
  });

  test("All is a place like any topic", async () => {
    await text("/agent proj");
    await settle();
    await text("task");
    assert.deepEqual(world.pis[0]?.prompts(), ["task"]);
    assert.equal(world.store.agent(ARTEM, undefined)?.cwd, join(world.home, "proj"));
  });

  test("a topic deleted by the user takes its agent", async () => {
    const pi = await agentInTopic();
    await text("task", TOPIC);
    world.tg.failNext("sendRichMessage", "Bad Request: message thread not found");
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Answer." } });
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    assert.equal(world.store.agent(ARTEM, TOPIC), undefined);
    assert.equal(pi.closed, true);
  });

  test("an unexpected exit of pi is reported with sound; the next message starts a new process", async () => {
    const pi = await agentInTopic();
    pi.crash();
    await settle();
    assert.match(loud().at(-1) ?? "", /pi exited unexpectedly/);
    await text("again", TOPIC);
    assert.equal(world.pis.length, 2);
    assert.deepEqual(world.pis[1]?.prompts(), ["again"]);
  });
});
