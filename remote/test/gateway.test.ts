/**
 * Scenarios of the gateway end to end, with a recording Bot API, scripted pi
 * processes, a fake user helper and a fake clock: workspaces (private chat,
 * groups), agents attached and in the background, runs, dialogs, sound,
 * crashes, the gateway stopping, and the Mini App API over HTTP.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { FakeClock, FakeHelper, FakePi, FakeTelemetry, FakeTg, ok, settle } from "./fakes.ts";

const ARTEM = 11;
const STRANGER = 99;
const GROUP = -500;
const TOKEN = "123:abc";

type World = {
  router: Router;
  wb: Workbench;
  tg: FakeTg;
  clock: FakeClock;
  pis: FakePi[];
  store: StateStore;
  helper: FakeHelper;
  home: string;
  dataDir: string;
  config: Config;
  t: FakeTelemetry;
  downloads: Map<string, Buffer>;
};

let world: World;
let updateId = 1;
let messageId = 1000;

function makeWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const user: UserConfig = { name: "artem", telegramId: ARTEM, uid: 1001, gid: 1001, git: { name: "A", email: "a@x" }, publicKeys: [], admin: true };
  const config: Config = {
    telegram: { tokenVariable: "T", webhookSecretVariable: "W", publicUrl: "https://x/telegram", listenPort: 1 },
    runAs: "self",
    dataDir,
    paths: { pi: "pi", cage: "cage", envsDir: join(dataDir, "envs"), machineIdentity: "" },
    users: [user],
    limits: { sessionsPerUser: 3, sessionsTotal: 4, idleMinutes: 30, idleShutdownMinutes: 15 },
    telemetry: { retentionDays: 30 },
    defaultSettings: {},
  };
  const t = new FakeTelemetry();
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
    t,
    resources: () => ({ memFreeMb: 100 }),
    spawn: (spec, handlers) => {
      const pi = new FakePi(spec, handlers);
      pis.push(pi);
      return pi;
    },
    spec: (_user, sessionId, cwd) => ({ command: "pi", args: ["--session-id", sessionId], cwd, env: {} }),
  });
  const downloads = new Map<string, Buffer>();
  const router = new Router({
    workbench: wb,
    clock,
    t,
    download: async (fileId) => downloads.get(fileId) ?? Buffer.from(`content of ${fileId}`),
    journal: () => [{ ts: "2026-11-08T00:00:00.000Z", level: "error", kind: "agent.exit", message: "boom" }],
    activity: () => undefined,
  });
  return { router, wb, tg, clock, pis, store, helper, home, dataDir, config, t, downloads };
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

  test("strangers are ignored (journaled); /start answers with the status; the private chat becomes a workspace", async () => {
    await text("hi", ARTEM, STRANGER);
    assert.deepEqual(world.tg.calls, []);
    assert.ok(world.t.kinds("warn").includes("update.stranger"));
    await text("/start");
    assert.deepEqual(sent(), [{ chat: ARTEM, text: NO_AGENT_LINE(ARTEM), loud: false, keyboard: [] }]);
    assert.deepEqual(world.store.workspace(ARTEM), { chatId: ARTEM, kind: "private", owner: ARTEM, title: "Direct" });
  });

  test("no agent: one silent link to the Mini App; /new without a path links to its Files screen", async () => {
    await text("fix the bug");
    await text("/new");
    assert.deepEqual(sent(), [
      { chat: ARTEM, text: NO_AGENT_LINE(ARTEM), loud: false, keyboard: [] },
      { chat: ARTEM, text: `[Choose a directory…](https://t.me/bot?startapp=w${ARTEM}_files&mode=compact)`, loud: false, keyboard: [] },
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
    assert.ok(!world.tg.methods().some((m) => /Draft|Reaction|ChatAction|ForumTopic/i.test(m)));
    const answerId = world.tg.calls.find((c) => c.method === "sendRichMessage" && (c.args[1] as { markdown: string }).markdown === "The plan.")?.result as { message_id: number };
    assert.deepEqual(world.tg.of("pinChatMessage"), [[ARTEM, answerId.message_id, { disable_notification: true }]], "the final answer is pinned");
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

  test("send_file: a document where the agent is, with its comment, with sound, pinned; in the background under the header", async () => {
    writeFileSync(join(world.home, "proj", "report.txt"), "the report");
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    await text("make a report");
    const details = { path: join(world.home, "proj", "report.txt"), name: "report.txt", size: 10, comment: "Q3 <report>" };
    pi.emit({ type: "tool_execution_end", toolCallId: "f", toolName: "send_file", result: { details }, isError: false });
    await world.wb.drain();
    const [doc] = world.tg.of("sendDocument");
    assert.equal(doc?.[0], ARTEM);
    assert.deepEqual(doc?.[2], { caption: "Q3 &lt;report&gt;", parse_mode: "HTML", disable_notification: false });
    const docId = (world.tg.calls.find((c) => c.method === "sendDocument")?.result as { message_id: number }).message_id;
    assert.ok(world.tg.of("pinChatMessage").some((args) => args[1] === docId));

    await text("/detach");
    pi.emit({ type: "tool_execution_end", toolCallId: "g", toolName: "send_file", result: { details: { ...details, path: join(world.home, "nope.txt") } }, isError: false });
    await world.wb.drain();
    assert.match(loud().at(-1) ?? "", /could not send report\.txt/);
    assert.ok(world.t.kinds("error").includes("file.send"));
  });

  test("the service message about the bot's own pin is deleted; others' pins stay", async () => {
    await world.wb.outbox(ARTEM).pin(55);
    const pinned = (id: number) =>
      send({ message: { message_id: messageId++, date: 0, chat: chat(ARTEM), from: { id: 1, is_bot: true, first_name: "bot" }, pinned_message: { message_id: id, date: 0, chat: chat(ARTEM) } } } as Omit<Update, "update_id">);
    await pinned(55);
    await pinned(56);
    await world.wb.outbox(ARTEM).flush();
    assert.deepEqual(world.tg.of("deleteMessage"), [[ARTEM, messageId - 2]]);
  });

  test("/diff: the changes (tracked and untracked) as a .diff document; no changes; not a repository; never to the model", async () => {
    const repo = join(world.home, "proj");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: repo });
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    await text("/new proj");
    await text("/diff");
    await world.wb.outbox(ARTEM).flush();
    assert.equal(sent().at(-1)?.text, "No changes in ~/proj.");
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    await text("/diff");
    await world.wb.outbox(ARTEM).flush();
    const doc = world.tg.of("sendDocument").at(-1);
    assert.equal((doc?.[2] as { caption: string }).caption, "~/proj · 2 files");
    const patch = ((doc?.[1] as { fileData: Buffer }).fileData).toString("utf8");
    assert.match(patch, /^-one\n\+two$/m);
    assert.match(patch, /^\+\+\+ b\/b\.txt$/m);
    await text("/new zeta");
    await text("/diff");
    await world.wb.outbox(ARTEM).flush();
    assert.equal(sent().at(-1)?.text, "~/zeta is not a git repository.");
    assert.ok(world.pis.every((pi) => !pi.prompts().some((p) => p.startsWith("/diff"))));
  });

  test("/status: the agent here (model, state, context, cost) and the other agents", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    pi.respond = (command) =>
      command.type === "get_session_stats" ? ok("get_session_stats", { cost: 0.456, contextUsage: { percent: 30.4 } }) : command.type === "prompt" ? ok("prompt", { disposition: "started" }) : ok(command.type);
    await text("task");
    await world.clock.advance(72_000);
    await text("/detach");
    await text("/new zeta");
    await text("/status");
    await world.wb.outbox(ARTEM).flush();
    assert.equal(sent().at(-1)?.text, [
      `[~/zeta · new session](https://t.me/bot?startapp=w${ARTEM}&mode=compact)`,
      "deepseek-v4-pro · high · idle",
      "1 more agent: ~/proj (running, background)",
    ].join("\n"));
    await text("/close");
    await press("s:closeyes", ARTEM, world.tg.sentId(/^Close the agent/));
    await press(`t:${pi.spec.args[1]}`);
    await text("/status");
    await world.wb.outbox(ARTEM).flush();
    assert.match(sent().at(-1)?.text ?? "", /\n\S+ · high · running 1m 12s · context 30% · \$0\.46$/);
  });

  test("files of a message and of the message it replies to are saved to ~/tmp and listed first", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    const original = { message_id: 900, date: 0, chat: chat(ARTEM), from: { id: ARTEM, is_bot: false, first_name: "A" }, document: { file_id: "old", file_unique_id: "o", file_name: "data.csv", file_size: 2048 } };
    await send({
      message: {
        message_id: 901,
        date: 0,
        chat: chat(ARTEM),
        from: { id: ARTEM, is_bot: false, first_name: "A" },
        caption: "compare these",
        document: { file_id: "new", file_unique_id: "n", file_name: "report.pdf", file_size: 1_300_000 },
        reply_to_message: original,
      },
    } as Omit<Update, "update_id">);
    const prompt = pi.prompts().at(-1) ?? "";
    const dir = join(world.home, "tmp");
    assert.equal(prompt, [
      "Attached files:",
      `- ${dir}/${ARTEM}-901/report.pdf (1.2 MB)`,
      `- ${dir}/${ARTEM}-900/data.csv (2 KB, from the message you replied to)`,
      "",
      "compare these",
    ].join("\n"));
    assert.equal(readFileSync(`${dir}/${ARTEM}-901/report.pdf`, "utf8"), "content of new");
  });

  test("an album is one prompt once 1.5 s pass without a new part; files over 20 MB are listed as not downloaded", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    const part = (id: number, photo: { file_id: string; file_size: number }, caption?: string) =>
      send({
        message: { message_id: id, date: 0, chat: chat(ARTEM), from: { id: ARTEM, is_bot: false, first_name: "A" }, media_group_id: "g", photo: [{ ...photo, file_unique_id: photo.file_id, width: 1, height: 1 }], ...(caption !== undefined ? { caption } : {}) },
      } as Omit<Update, "update_id">);
    const first = part(910, { file_id: "p1", file_size: 1000 }, "two shots");
    await world.clock.advance(1_000);
    const second = part(911, { file_id: "p2", file_size: 30 * 1024 * 1024 });
    await world.clock.advance(1_499);
    assert.deepEqual(pi.prompts(), [], "still collecting");
    await world.clock.advance(1);
    await Promise.all([first, second]);
    const prompt = pi.prompts().at(-1) ?? "";
    assert.match(prompt, /^Attached files:\n- \S+\/11-910\/photo-910\.jpg \(1000 B\)\n- photo-911\.jpg \(30\.0 MB, not downloaded: over Telegram's 20 MB limit for bots\)\n\ntwo shots$/);
    const images = (pi.requests.filter((r) => r.type === "prompt").at(-1) as { images?: unknown[] }).images;
    assert.equal(images?.length, 1);
  });

  test("voice: the transcript grows in one reply, ends as Voice: …, and the prompt says it is the transcript of the file", async () => {
    await text("/new proj");
    const pi = world.pis[0];
    assert.ok(pi !== undefined);
    const voice = send({
      message: { message_id: 920, date: 0, chat: chat(ARTEM), from: { id: ARTEM, is_bot: false, first_name: "A" }, voice: { file_id: "v", file_unique_id: "v", duration: 42, file_size: 5000 } },
    } as Omit<Update, "update_id">);
    const transcription = await world.helper.nextTranscription();
    await world.wb.drain();
    assert.equal(transcription.file, join(world.home, "tmp", `${ARTEM}-920`, "voice.ogg"));
    assert.equal(world.wb.isQuiescent(), false, "a transcription keeps the machine awake");
    const progress = world.tg.calls.find((c) => c.method === "sendMessage" && c.args[1] === "Transcribing…");
    assert.deepEqual((progress?.args[2] as { reply_parameters?: unknown }).reply_parameters, { message_id: 920, allow_sending_without_reply: true });
    transcription.onDelta("Привет, ");
    await world.clock.advance(3_000);
    await world.wb.outbox(ARTEM).flush();
    assert.equal(world.tg.of("editMessageText").at(-1)?.[2], "Transcribing…\nПривет, ");
    transcription.onDelta("мир");
    transcription.finish({ ok: true, data: "Привет, мир" });
    await voice;
    await world.wb.drain();
    assert.equal(world.tg.of("editMessageText").at(-1)?.[2], "Voice: Привет, мир");
    assert.equal(pi.prompts().at(-1), [
      "Attached files:",
      `- ${join(world.home, "tmp", `${ARTEM}-920`, "voice.ogg")} (5 KB, voice message, 0:42)`,
      "",
      "This message was spoken: its text below is the transcript of the attached voice.ogg. Work with the text; the audio needs no processing.",
      "",
      "Привет, мир",
    ].join("\n"));
    assert.equal(world.wb.isQuiescent(), false, "the run started by the voice runs");
  });

  test("voice without an OpenAI login: an error with sound, nothing to the agent", async () => {
    await text("/new proj");
    const voice = send({
      message: { message_id: 930, date: 0, chat: chat(ARTEM), from: { id: ARTEM, is_bot: false, first_name: "A" }, voice: { file_id: "v", file_unique_id: "v", duration: 3, file_size: 100 } },
    } as Omit<Update, "update_id">);
    (await world.helper.nextTranscription()).finish({ ok: false, problem: "no OpenAI login" });
    await voice;
    await world.wb.drain();
    assert.equal(loud().at(-1), "Error: Voice needs an OpenAI login: /login → OpenAI Codex.");
    assert.deepEqual(world.pis[0]?.prompts(), []);
  });

  test("/logs: admins get the journal as a document; for others it is just a command for the agent", async () => {
    await text("/logs 2");
    await world.wb.outbox(ARTEM).flush();
    const doc = world.tg.of("sendDocument").at(-1);
    assert.equal((doc?.[2] as { caption: string }).caption, "1 events, 1 errors");
    assert.match((doc?.[1] as { filename: string }).filename, /^gateway-\d{8}T\d{4}-\d{8}T\d{4}\.jsonl$/);
    (world.config.users[0] as { admin: boolean }).admin = false;
    await text("/logs");
    assert.equal(sent().at(-1)?.text, NO_AGENT_LINE(ARTEM));
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
    const app = createApp({ workbench: world.wb, helper: world.helper, assets, botToken: TOKEN, clock: world.clock, t: world.t, activity: () => undefined });
    server = await startServer({ port: 0, webhookPath: "/telegram", webhookSecret: "s", onUpdate: () => undefined, app: () => app, t: world.t });
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

  test("Files: list (directories first), never outside ~, a new folder, downloads as a document (a folder as a zip)", async () => {
    writeFileSync(join(world.home, "proj", "a.txt"), "aaa");
    writeFileSync(join(world.home, ".hidden"), "");
    const listed = (await api("/app/api/files?path=~")).json as unknown as { path: string; entries: { name: string; kind: string; hidden: boolean }[] };
    assert.equal(listed.path, "~");
    assert.deepEqual(listed.entries.map((e) => [e.name, e.kind, e.hidden]), [["proj", "dir", false], ["zeta", "dir", false], [".hidden", "file", true]]);
    const outside = await api("/app/api/files?path=../..");
    assert.equal(outside.status, 409);
    assert.match(outside.json.problem ?? "", /outside your home/);
    assert.equal((await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "mkdir", path: "~/proj", name: "new" })).status, 200);
    assert.equal((await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "mkdir", path: "~/proj", name: "../x" })).status, 409);
    assert.deepEqual(((await api("/app/api/files?path=~/proj")).json as unknown as { entries: { name: string }[] }).entries.map((e) => e.name), ["new", "a.txt"]);
    assert.equal((await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "download", path: "~/proj" })).status, 200);
    assert.equal((await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "download", path: "~/proj/a.txt" })).status, 200);
    await world.wb.drain();
    const [zip, file] = world.tg.of("sendDocument");
    assert.equal((zip?.[1] as { filename: string }).filename, "proj.zip");
    const zipPath = join(world.dataDir, "proj.zip");
    writeFileSync(zipPath, (zip?.[1] as { fileData: Buffer }).fileData);
    assert.match(execFileSync("unzip", ["-l", zipPath]).toString("utf8"), /proj\/a\.txt/);
    assert.equal((file?.[1] as { fileData: Buffer }).fileData.toString("utf8"), "aaa");
    assert.deepEqual(file?.[2], { caption: "~/proj/a.txt", parse_mode: "HTML", disable_notification: true });
  });

  test("Models: favorites saved; switching the model here applies the favorite's effort", async () => {
    world.helper.modelSettings = {
      available: [{ provider: "deepseek", id: "deepseek-flash", name: "Flash", levels: ["off", "high", "max"] }],
      favorites: [],
      patterns: [],
      default: null,
    };
    const saved = await api("/app/api/settings/models", ARTEM, { favorites: [{ provider: "deepseek", id: "deepseek-flash", effort: "max" }], default: { provider: "deepseek", id: "deepseek-flash" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(world.helper.saved.at(-1), { favorites: [{ provider: "deepseek", id: "deepseek-flash", effort: "max" }], default: { provider: "deepseek", id: "deepseek-flash" } });
    const started = await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "new", dir: "~/proj" });
    const agentId = started.json.state?.agents[0]?.id ?? "";
    await api(`/app/api/action?ws=${ARTEM}`, ARTEM, { type: "model", agentId, provider: "deepseek", id: "deepseek-flash" });
    const requests = (world.pis[0]?.requests ?? []).filter((r) => r.type === "set_model" || r.type === "set_thinking_level");
    assert.deepEqual(requests, [
      { type: "set_model", provider: "deepseek", modelId: "deepseek-flash" },
      { type: "set_thinking_level", level: "max" },
    ]);
  });

  test("errors of the page are journaled (and alerted) with a valid initData only", async () => {
    const unsigned = await fetch(`${base}/app/api/telemetry`, { method: "POST", body: JSON.stringify({ message: "x" }) });
    assert.equal(unsigned.status, 401);
    assert.equal((await api("/app/api/telemetry", ARTEM, { message: "TypeError: boom", stack: "at app.js:1" })).status, 200);
    assert.deepEqual(world.t.events.filter((e) => e.kind === "app.error").map((e) => e.fields.message), ["TypeError: boom"]);
  });
});
