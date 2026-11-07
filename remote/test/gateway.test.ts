/**
 * Scenarios of the gateway end to end, with a recording Bot API, scripted pi
 * processes and a fake clock: topics and directories, runs and steering,
 * dialogs, banners, the native stop, deleted topics, crashes, quiescence.
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
import { FakeClock, FakePi, FakeTg, settle } from "./fakes.ts";

const ARTEM = 11;
const STRANGER = 99;

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
  for (const dir of subdirs) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(home, { recursive: true });
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
    spec: (_user, topic) => ({ command: "pi", args: ["--session-id", topic.sessionId], cwd: topic.cwd, env: {} }),
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

function topicCreated(threadId: number, name: string, implicit: boolean): Promise<void> {
  return send({
    message: {
      message_id: threadId,
      date: 0,
      chat: { id: ARTEM, type: "private", first_name: "A" },
      from: { id: ARTEM, is_bot: false, first_name: "A" },
      message_thread_id: threadId,
      is_topic_message: true,
      forum_topic_created: { name, icon_color: 0, ...(implicit ? { is_name_implicit: true } : {}) },
    },
  } as Omit<Update, "update_id">);
}

function press(data: string, threadId: number): Promise<void> {
  return send({
    callback_query: {
      id: `cb${updateId}`,
      from: { id: ARTEM, is_bot: false, first_name: "A" },
      chat_instance: "x",
      data,
      message: { message_id: 1, date: 0, chat: { id: ARTEM, type: "private", first_name: "A" }, message_thread_id: threadId, is_topic_message: true },
    },
  } as Omit<Update, "update_id">);
}

function sentTexts(): string[] {
  return world.tg.of("sendMessage").map((args) => String(args[1]));
}

function reactions(): string[] {
  return world.tg.of("setMessageReaction").map((args) => (args[2] as { emoji: string }[])[0]?.emoji ?? "");
}

/** Binds topic 7 to ~/proj and returns its pi. */
async function boundTopic(): Promise<FakePi> {
  await topicCreated(7, "New topic", false);
  await text("first task", 7);
  await press("p:1", 7);
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

  test("strangers and non-private chats are ignored", async () => {
    await text("hi", undefined, STRANGER);
    assert.deepEqual(world.tg.calls, []);
  });

  test("a new topic: held messages, directory choice, rename, card, one prompt", async () => {
    await topicCreated(7, "New topic", false);
    await text("first task", 7);
    const choice = world.tg.of("sendMessage")[0];
    assert.equal(choice?.[1], "📁 <b>Where to work?</b>");
    const buttons = (choice?.[2] as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ["~", "~/proj", "~/zeta", "📁 Path…"]);
    await text("and more", 7);
    await press("p:1", 7);
    await settle();
    assert.deepEqual(world.tg.of("editForumTopic")[0]?.[2], { name: "~/proj" });
    const topic = world.store.topic(ARTEM, 7);
    assert.equal(topic?.cwd, join(world.home, "proj"));
    assert.equal(topic?.title, "~/proj");
    assert.equal(world.tg.of("pinChatMessage").length, 1);
    const pi = world.pis[0];
    assert.equal(pi?.spec.cwd, join(world.home, "proj"));
    assert.deepEqual(pi?.prompts(), ["first task\n\nand more"]);
    assert.deepEqual(world.store.user(ARTEM).recentDirs, [join(world.home, "proj")]);
    assert.equal(world.gateway.isQuiescent(), false, "a run is in progress");
  });

  test("a topic named by the user keeps its name; Path… resolves inside ~ only", async () => {
    await topicCreated(8, "My fix", false);
    await text("task", 8);
    await press("p:path", 8);
    await text("../..", 8);
    assert.ok(sentTexts().some((t) => /outside your home/.test(t)));
    assert.match(sentTexts().at(-1) ?? "", /Where to work/, "the choice stays the last message");
    await text("~/zeta", 8);
    await settle();
    assert.equal(world.store.topic(ARTEM, 8)?.cwd, join(world.home, "zeta"));
    assert.deepEqual(world.tg.of("editForumTopic"), []);
    assert.equal(world.store.topic(ARTEM, 8)?.title, "My fix");
  });

  test("build from the card applies to one message; ! builds; messages during a run steer", async () => {
    const pi = await boundTopic();
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    await press("c:mode:build", 7);
    assert.equal(world.store.topic(ARTEM, 7)?.nextMode, "build");
    await text("do it", 7);
    assert.equal(world.store.topic(ARTEM, 7)?.nextMode, "plan");
    await text("also this", 7);
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    await text("!now", 7);
    const prompts = pi.requests.filter((r) => r.type === "prompt") as { message: string; streamingBehavior?: string }[];
    assert.deepEqual(prompts.map((p) => [p.message, p.streamingBehavior]), [
      ["first task", undefined],
      ["!do it", undefined],
      ["also this", "steer"],
      ["!now", undefined],
    ]);
    assert.ok(reactions().includes("✍"));
  });

  test("the gate dialog stays last; text rejects with a comment", async () => {
    const pi = await boundTopic();
    pi.ui({ type: "extension_ui_request", id: "g", method: "select", title: `${GATE_TITLE}\nedit x`, options: Object.values(GATE_OPTIONS) });
    await settle();
    assert.equal(world.gateway.isQuiescent(), false);
    await text("wrong file", 7);
    pi.ui({ type: "extension_ui_request", id: "c", method: "input", title: "Why reject? Required — the model sees this comment." });
    await settle();
    assert.deepEqual(pi.uiResponses, [
      { type: "extension_ui_response", id: "g", value: "Reject with comment" },
      { type: "extension_ui_response", id: "c", value: "wrong file" },
    ]);
  });

  test("the banner closes a planning run with Build buttons; 🔨 Build sends the build prompt", async () => {
    const pi = await boundTopic();
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "The plan." } });
    pi.emit({ type: "entry_appended", entry: { type: "custom", customType: FINISHED_ENTRY_TYPE, data: { mode: "plan", durationMs: 5000, costUsd: 0.01, model: "deepseek/v4" } } });
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    const final = world.tg.of("sendRichMessage").at(-1);
    assert.deepEqual(final?.[1], { markdown: "The plan.\n\n✅ planning finished · 5s · $0.01 · v4" });
    assert.ok(reactions().includes("👌"));
    assert.equal(world.gateway.isQuiescent(), true);
    await press("r:build", 7);
    assert.equal(pi.prompts().at(-1), "!Implement the agreed plan.");
  });

  test("the draft's native stop aborts the run", async () => {
    const pi = await boundTopic();
    await send({ stopped_message_generation: { chat: { id: ARTEM, type: "private", first_name: "A" }, message_thread_id: 7, draft_id: 1 } } as Omit<Update, "update_id">);
    assert.ok(pi.requests.some((r) => r.type === "abort"));
  });

  test("a message in All moves into a new topic; with nothing to choose it starts in ~", async () => {
    world = makeWorld([]);
    await text("fix the bug");
    assert.deepEqual(world.tg.of("createForumTopic")[0]?.slice(0, 2), [ARTEM, "fix the bug"]);
    assert.equal(world.tg.of("copyMessage").length, 1);
    assert.equal(world.tg.of("deleteMessage").length, 1);
    await settle();
    const threadId = world.tg.of("copyMessage")[0]?.[3] as { message_thread_id: number };
    assert.equal(world.store.topic(ARTEM, threadId.message_thread_id)?.cwd, world.home);
    assert.deepEqual(world.pis[0]?.prompts(), ["fix the bug"]);
  });

  test("a mobile client's implicit topic is adopted instead of creating another", async () => {
    world = makeWorld([]);
    await topicCreated(42, "fix the bug", true);
    await world.clock.advance(3000);
    await text("fix the bug");
    assert.deepEqual(world.tg.of("createForumTopic"), []);
    assert.equal((world.tg.of("copyMessage")[0]?.[3] as { message_thread_id: number }).message_thread_id, 42);
  });

  test("a topic deleted by the user closes its session", async () => {
    const pi = await boundTopic();
    world.tg.failNext("sendRichMessage", "Bad Request: message thread not found");
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Answer." } });
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    assert.equal(world.store.topic(ARTEM, 7)?.closed, true);
    assert.equal(pi.closed, true);
  });

  test("an unexpected exit of pi is reported; the next message starts a new process", async () => {
    const pi = await boundTopic();
    pi.crash();
    await settle();
    assert.match(sentTexts().at(-1) ?? "", /pi exited unexpectedly/);
    assert.ok(reactions().includes("💔"));
    await text("again", 7);
    assert.equal(world.pis.length, 2);
    assert.deepEqual(world.pis[1]?.prompts(), ["again"]);
  });

  test("close: process stopped, topic renamed and marked closed", async () => {
    const pi = await boundTopic();
    pi.emit({ type: "agent_settled", aborted: false });
    await settle();
    await press("c:close", 7);
    await press("c:closeyes", 7);
    assert.equal(pi.closed, true);
    assert.equal(world.store.topic(ARTEM, 7)?.closed, true);
    assert.deepEqual(world.tg.of("editForumTopic").at(-1)?.[2], { name: "✓ ~/proj" });
    await text("more", 7);
    assert.match(sentTexts().at(-1) ?? "", /closed/);
  });
});
