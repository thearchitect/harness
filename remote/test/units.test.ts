/**
 * Unit tests of the gateway's pure and timer-driven parts: config, dotenv,
 * render, links, history, pool, idle shutdown, outbox, block stream, dialogs,
 * account, agent (deadlines and watchdog), agents (life cycle), Mini App
 * assets and auth.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Assets } from "../app/assets.ts";
import { MAX_AGE_MS, verifyInitData } from "../app/auth.ts";
import { parseConfig } from "../config.ts";
import { ABORT_GRACE_MS, Agent, MODEL_SILENCE_MS, REQUEST_TIMEOUT_MS, START_TIMEOUT_MS, TOOL_SILENCE_MS, type AgentListener, type PiProcess } from "../core/agent.ts";
import { Agents } from "../core/agents.ts";
import { IdleShutdown } from "../core/idle.ts";
import { SessionPool, type PoolProcess } from "../core/pool.ts";
import type { RpcHandlers, RpcSpec } from "../core/rpc.ts";
import { StateStore } from "../core/state.ts";
import { parseDotenv } from "../dotenv.ts";
import { Account, INPUT_TIMEOUT_MS, LOGIN_TIMEOUT_MS } from "../telegram/account.ts";
import { BlockStream, FLUSH_INTERVAL_MS } from "../telegram/blocks.ts";
import { Dialogs, INTERRUPTED } from "../telegram/dialogs.ts";
import { historyPages } from "../telegram/history.ts";
import { appLink, parseStartParam } from "../telegram/links.ts";
import { Outbox } from "../telegram/outbox.ts";
import { bannerLine, fence, PAGE_LIMIT, renderBlock, splitText, stripAnsi, toolSummary } from "../telegram/render.ts";
import type { Config } from "../config.ts";
import { FakeClock, FakeHelper, FakePi, FakeTg, ok, settle } from "./fakes.ts";

const VALID = `
telegram: { tokenVariable: T, webhookSecretVariable: W, publicUrl: "https://x.fly.dev/telegram", listenPort: 8080 }
runAs: users
dataDir: /data
paths: { pi: /bin/pi, cage: /bin/cage, envsDir: /etc/envs, machineIdentity: /run/id }
users:
  - { name: artem, telegramId: 1, uid: 1001, git: { name: A, email: a@x }, publicKeys: ["ssh-ed25519 AAA a"] }
  - { name: oksana, telegramId: 2, uid: 1002, git: { name: O, email: o@x }, publicKeys: ["ssh-ed25519 BBB o"] }
limits: { sessionsPerUser: 2, sessionsTotal: 4, idleMinutes: 30, idleShutdownMinutes: 15 }
defaultSettings: { defaultProvider: deepseek }
`;

describe("config", () => {
  test("a valid YAML configuration", () => {
    const result = parseConfig(VALID, true);
    assert.ok("config" in result, JSON.stringify(result));
    assert.equal(result.config.users[1]?.gid, 1002);
    assert.equal(result.config.limits.sessionsTotal, 4);
  });

  test("the JSON of the image reads the same", () => {
    const yaml = parseConfig(VALID, true);
    assert.ok("config" in yaml);
    assert.deepEqual(parseConfig(JSON.stringify(yaml.config), true), yaml);
  });

  test("every problem names its field", () => {
    const broken = VALID.replace("uid: 1002", "uid: 1001").replace("name: oksana", "name: Oksana").replace("listenPort: 8080", "listenPort: 0");
    const result = parseConfig(broken, false);
    assert.ok("problems" in result);
    assert.deepEqual(result.problems.sort(), [
      "runAs: users requires the gateway to run as root",
      "telegram.listenPort: must be an integer in 1..65535",
      "users[1].name: must match /^[a-z][a-z0-9-]{0,31}$/",
      "users[1].uid: duplicate 1001",
    ]);
  });

  test("missing fields and duplicates of telegramId", () => {
    const result = parseConfig(VALID.replace("telegramId: 2", "telegramId: 1").replace("dataDir: /data", ""), true);
    assert.ok("problems" in result);
    assert.deepEqual(result.problems.sort(), ["dataDir: missing a non-empty string", "users[1].telegramId: duplicate 1"]);
  });
});

test("dotenv of cage dump: plain and shell-quoted values", () => {
  const values = parseDotenv("A=plain\nB='with space'\nC='it'\\''s'\n# comment\n\nD=''\n");
  assert.deepEqual([...values], [["A", "plain"], ["B", "with space"], ["C", "it's"], ["D", ""]]);
});

describe("render", () => {
  test("a fence is longer than any backtick run inside", () => {
    assert.equal(fence("a ```` b"), "`````\na ```` b\n`````");
    assert.equal(fence("x", "json"), "```json\nx\n```");
  });

  test("blocks: thinking live then collapsed, tool collapsed with status, text as is, ANSI stripped", () => {
    assert.deepEqual(renderBlock({ kind: "thinking", text: "hmm", done: false }), ["_Thinking…_\n\nhmm"]);
    assert.deepEqual(renderBlock({ kind: "thinking", text: "hmm", done: true }), ["<details><summary>Thinking</summary>\n\nhmm\n\n</details>"]);
    assert.deepEqual(renderBlock({ kind: "text", text: "\u001b[31mHello\u001b[0m", done: false }), ["Hello"]);
    const running = renderBlock({ kind: "tool", id: "1", name: "bash", args: { command: "ls -la" }, done: false });
    assert.match(running[0] ?? "", /^<details><summary>bash: ls -la · running<\/summary>/);
    const failed = renderBlock({ kind: "tool", id: "1", name: "bash", args: { command: "ls -la" }, result: "x".repeat(3100), isError: true, durationMs: 1500, done: true });
    assert.match(failed[0] ?? "", /^<details><summary>bash: ls -la · 2s · failed<\/summary>/);
    assert.match(failed[0] ?? "", /… 100 more chars/);
  });

  test("a long block continues on further pages", () => {
    const pages = renderBlock({ kind: "thinking", text: `${"a".repeat(PAGE_LIMIT - 10)}\n${"b".repeat(100)}`, done: true });
    assert.equal(pages.length, 2);
    assert.match(pages[1] ?? "", /^<details><summary>Thinking \(continued\)<\/summary>/);
  });

  test("tool summaries pick the meaningful argument and stay short", () => {
    assert.equal(toolSummary("read", { path: "src/a.ts", limit: 3 }), "read: src/a.ts");
    assert.equal(toolSummary("x", { a: 1 }), 'x: {"a":1}');
    assert.equal(toolSummary("bash", { command: "y".repeat(200) }).length, 80);
  });

  test("long text splits at line boundaries below the limit", () => {
    const parts = splitText(`${"a".repeat(60)}\n${"b".repeat(60)}`, 100);
    assert.deepEqual(parts, ["a".repeat(60), "b".repeat(60)]);
  });

  test("banner", () => {
    assert.equal(bannerLine({ mode: "plan", durationMs: 134_000, costUsd: 0.1234, model: "deepseek/deepseek-v4-pro" }), "planning finished · 2m 14s · $0.12 · deepseek-v4-pro");
    assert.equal(bannerLine({ mode: "normal", interrupted: true }), "building interrupted");
    assert.equal(stripAnsi("\u001b[1mx\u001b[0m"), "x");
  });
});

describe("links and history", () => {
  test("Mini App links carry the workspace (negative for groups) and the section", () => {
    assert.equal(appLink("bot", -1001234, "model"), "https://t.me/bot?startapp=w-1001234_model&mode=compact");
    assert.deepEqual(parseStartParam("w-1001234_model"), { chatId: -1001234, section: "model" });
    assert.deepEqual(parseStartParam("w42"), { chatId: 42, section: undefined });
    assert.equal(parseStartParam("x42"), undefined);
  });

  test("history: header, then each prompt quoted with its answer, packed into pages", () => {
    const pages = historyPages("[~/p · s](https://l)", [
      { prompt: "fix it\nplease", answer: "Done." },
      { prompt: "and this", answer: "" },
    ]);
    assert.deepEqual(pages, ["[~/p · s](https://l)\n\n> fix it\n> please\n\nDone.\n\n> and this"]);
    const many = historyPages("h", Array.from({ length: 5 }, () => ({ prompt: "q", answer: "a".repeat(PAGE_LIMIT / 2) })));
    assert.ok(many.length > 1 && many.every((page) => page.length <= PAGE_LIMIT));
  });
});

class FakeProc implements PoolProcess {
  readonly exited: Promise<unknown>;
  signals: string[] = [];
  closed = false;
  private exit!: () => void;
  private readonly exitsOnClose: boolean;
  constructor(exitsOnClose = true) {
    this.exitsOnClose = exitsOnClose;
    this.exited = new Promise<void>((resolve) => (this.exit = resolve));
  }
  close(): void {
    this.closed = true;
    if (this.exitsOnClose) this.exit();
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.exit();
  }
}

describe("pool", () => {
  test("an idle process is reaped exactly at the idle limit", async () => {
    const clock = new FakeClock();
    const pool = new SessionPool<FakeProc>(clock, { perUser: 2, total: 4, idleMs: 1000 });
    const proc = new FakeProc();
    pool.add("a", 1, proc);
    await clock.advance(999);
    assert.equal(proc.closed, false);
    await clock.advance(1);
    assert.equal(proc.closed, true);
    assert.equal(pool.size, 0);
  });

  test("a busy process is not reaped; idle time counts from the end of the run", async () => {
    const clock = new FakeClock();
    const pool = new SessionPool<FakeProc>(clock, { perUser: 2, total: 4, idleMs: 1000 });
    const proc = new FakeProc();
    pool.add("a", 1, proc);
    pool.setBusy("a", true);
    await clock.advance(5000);
    assert.equal(proc.closed, false);
    assert.equal(pool.isQuiescent(), false);
    pool.setBusy("a", false);
    await clock.advance(999);
    assert.equal(proc.closed, false);
    await clock.advance(1);
    assert.equal(proc.closed, true);
  });

  test("limits evict the longest idle process, or refuse", async () => {
    const clock = new FakeClock();
    const pool = new SessionPool<FakeProc>(clock, { perUser: 2, total: 3, idleMs: 60_000 });
    const [a, b, c] = [new FakeProc(), new FakeProc(), new FakeProc()];
    pool.add("u1:a", 1, a);
    await clock.advance(10);
    pool.add("u1:b", 1, b);
    assert.deepEqual(pool.makeRoom(1), { ok: true });
    assert.equal(a.closed, true, "the user's longest idle goes first");
    pool.add("u2:c", 2, c);
    pool.setBusy("u1:b", true);
    pool.setBusy("u2:c", true);
    pool.add("u2:d", 2, new FakeProc());
    pool.setBusy("u2:d", true);
    const refused = pool.makeRoom(1);
    assert.equal(refused.ok, false);
  });

  test("a lingering process gets SIGTERM, then SIGKILL", async () => {
    const clock = new FakeClock();
    const pool = new SessionPool<FakeProc>(clock, { perUser: 2, total: 4, idleMs: 60_000 });
    const proc = new FakeProc(false);
    pool.add("a", 1, proc);
    const stopped = pool.stop("a");
    await clock.advance(10_000);
    assert.deepEqual(proc.signals, ["SIGTERM"]);
    await clock.advance(5_000);
    assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
    await stopped;
  });

  test("restartUser stops idle processes now and busy ones when they settle", async () => {
    const clock = new FakeClock();
    const pool = new SessionPool<FakeProc>(clock, { perUser: 4, total: 4, idleMs: 60_000 });
    const [idle, busy, other] = [new FakeProc(), new FakeProc(), new FakeProc()];
    pool.add("1:a", 1, idle);
    pool.add("1:b", 1, busy);
    pool.add("2:c", 2, other);
    pool.setBusy("1:b", true);
    pool.restartUser(1);
    await settle();
    assert.deepEqual([idle.closed, busy.closed, other.closed], [true, false, false]);
    pool.setBusy("1:b", false);
    await settle();
    assert.equal(busy.closed, true);
  });
});

describe("idle shutdown", () => {
  test("exactly after the idle time when quiescent; activity resets; busy re-arms", async () => {
    const clock = new FakeClock();
    let quiescent = true;
    let stopped = 0;
    const idle = new IdleShutdown(clock, 1000, () => quiescent, () => stopped++);
    await clock.advance(600);
    idle.activity();
    await clock.advance(999);
    assert.equal(stopped, 0);
    quiescent = false;
    await clock.advance(1);
    assert.equal(stopped, 0, "something waits: armed again");
    quiescent = true;
    await clock.advance(1000);
    assert.equal(stopped, 1);
    await clock.advance(5000);
    assert.equal(stopped, 1, "only once");
  });
});

function outbox(tg: FakeTg, gone: () => void = () => undefined): Outbox {
  return new Outbox(tg.api, 7, () => undefined, gone);
}

describe("outbox", () => {
  test("a transient keyboard loses its buttons when anything is posted below", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    const id = await box.send({ html: "panel" }, { role: "transient", keyboard: [[{ text: "x", callback_data: "s:x" }]] });
    await box.send({ html: "next" });
    assert.deepEqual(tg.methods(), ["sendMessage", "editMessageReplyMarkup", "sendMessage"]);
    assert.deepEqual(tg.of("editMessageReplyMarkup")[0]?.slice(0, 2), [7, id]);
  });

  test("a sticky dialog is re-sent below newer messages and stays last", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    const dialog = await box.send({ html: "Pick?" }, { role: "sticky", keyboard: [[{ text: "A", callback_data: "d:s:1:0" }]] });
    await box.send({ html: "notice" });
    assert.deepEqual(tg.methods(), ["sendMessage", "sendMessage", "deleteMessage", "sendMessage"]);
    assert.deepEqual(tg.of("deleteMessage")[0], [7, dialog]);
    assert.equal(tg.of("sendMessage")[2]?.[1], "Pick?");
    await box.userPosted();
    assert.deepEqual(tg.methods().slice(4), ["deleteMessage", "sendMessage"]);
    await box.closeSticky({ html: "Pick?\n\nA" });
    await box.send({ html: "after" });
    assert.deepEqual(tg.methods().slice(6), ["editMessageText", "sendMessage"], "a closed dialog no longer moves");
  });

  test("edits of unchanged text are not errors; an edit of a deleted message reports gone", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    tg.failNext("editMessageText", "Bad Request: message is not modified");
    assert.equal(await box.edit(101, { html: "same" }), "ok");
    tg.failNext("editMessageText", "Bad Request: message to edit not found");
    assert.equal(await box.edit(101, { html: "x" }), "gone");
  });

  test("a panel is edited in place while it is the last message, re-posted below otherwise, closed with its outcome", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    await box.showPanel({ html: "page 1", keyboard: [[{ text: "›", callback_data: "a:x" }]] });
    const panelId = 100;
    assert.equal(box.ownsPanel(panelId), true);
    await box.showPanel({ html: "page 2", keyboard: [[{ text: "‹", callback_data: "a:y" }]] });
    assert.deepEqual(tg.methods(), ["sendMessage", "editMessageText"]);
    await box.userPosted();
    assert.equal(box.ownsPanel(panelId), false, "a message below retires the panel");
    await box.showPanel({ html: "again", keyboard: [[{ text: "x", callback_data: "a:dismiss" }]] });
    assert.deepEqual(tg.methods().slice(2), ["editMessageReplyMarkup", "sendMessage"]);
    await box.closePanel("done");
    assert.deepEqual(tg.of("editMessageText").at(-1)?.slice(1, 3), [101, "done"]);
    await box.showPanel({ html: "more", keyboard: [[{ text: "x", callback_data: "a:dismiss" }]] });
    await box.closePanel(undefined);
    assert.equal(tg.methods().at(-1), "deleteMessage");
  });

  test("rich markdown Telegram cannot parse is resent as plain text", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    tg.failNext("sendRichMessage", "Bad Request: can't parse rich message");
    const id = await box.send({ markdown: "<broken" });
    assert.ok(id !== undefined);
    assert.deepEqual(tg.of("sendRichMessage")[1]?.[1], { blocks: [{ type: "pre", text: "<broken" }] });
  });

  test("a chat the bot can no longer write to is reported once and silences the outbox", async () => {
    const tg = new FakeTg();
    let gone = 0;
    const box = outbox(tg, () => gone++);
    tg.failNext("sendMessage", "Forbidden: bot was kicked from the group chat", 403);
    await box.send({ html: "a" });
    await box.send({ html: "b" });
    assert.equal(gone, 1);
    assert.equal(tg.of("sendMessage").length, 1);
  });
});

describe("block stream", () => {
  function rich(tg: FakeTg): { method: string; text: string; keyboard: string[] }[] {
    return tg.calls
      .filter((c) => c.method === "sendRichMessage" || c.method === "editMessageText")
      .map((c) => {
        const body = (c.method === "sendRichMessage" ? c.args[1] : c.args[2]) as { markdown?: string };
        const options = (c.method === "sendRichMessage" ? c.args[2] : c.args[3]) as { reply_markup?: { inline_keyboard?: { text: string }[][] } } | undefined;
        return { method: c.method, text: body.markdown ?? "", keyboard: (options?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text) };
      });
  }

  test("every block is a message of its own; edits at most every 3 s with the latest state; Stop rides on the last message", async () => {
    const clock = new FakeClock();
    const tg = new FakeTg();
    const blocks = new BlockStream(outbox(tg), clock, "x:s");
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } as never);
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" } } as never);
    await clock.advance(0);
    assert.deepEqual(rich(tg).map((c) => c.method), ["sendRichMessage", "editMessageText"], "sent, then Stop attached");
    assert.deepEqual(rich(tg)[1]?.keyboard, ["Stop"]);
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "m" } } as never);
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "m" } } as never);
    await clock.advance(FLUSH_INTERVAL_MS - 1);
    assert.equal(rich(tg).length, 2, "no edit before 3 s");
    await clock.advance(1);
    assert.deepEqual(rich(tg).at(-1), { method: "editMessageText", text: "_Thinking…_\n\nhmmm", keyboard: ["Stop"] }, "one edit with the latest text");
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hmmm" } } as never);
    blocks.onEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } as never);
    await clock.advance(FLUSH_INTERVAL_MS);
    const calls = rich(tg).slice(3);
    assert.deepEqual(calls.map((c) => [c.method, c.keyboard]), [
      ["editMessageText", ["Stop"]],
      ["sendRichMessage", []],
      ["editMessageText", []],
      ["editMessageText", ["Stop"]],
    ]);
    assert.match(calls[0]?.text ?? "", /^<details><summary>Thinking<\/summary>/);
    assert.match(calls[1]?.text ?? "", /bash: ls · running/);
  });

  test("finish: final states, no Stop, the banner with sound; a deleted block message is sent again", async () => {
    const clock = new FakeClock();
    const tg = new FakeTg();
    const blocks = new BlockStream(outbox(tg), clock, "x:s");
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as never);
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } } as never);
    await clock.advance(0);
    blocks.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" } } as never);
    tg.failNext("editMessageText", "Bad Request: message to edit not found");
    await blocks.finish("~/p · planning finished");
    const sent = tg.calls.filter((c) => c.method === "sendRichMessage");
    assert.deepEqual(sent.map((c) => (c.args[1] as { markdown: string }).markdown), ["Hel", "Hello", "~/p · planning finished"]);
    assert.deepEqual(sent.map((c) => (c.args[2] as { disable_notification: boolean }).disable_notification), [true, true, false]);
    assert.equal(clock.pending(), 0);
  });
});

describe("dialogs", () => {
  function setup(): { tg: FakeTg; dialogs: Dialogs; responses: unknown[]; clock: FakeClock } {
    const tg = new FakeTg();
    const clock = new FakeClock();
    const responses: unknown[] = [];
    const dialogs = new Dialogs({ clock, respond: (r) => responses.push(r) }, "s1", { outbox: outbox(tg) });
    return { tg, dialogs, responses, clock };
  }

  test("select as buttons with sound; a press answers; a text instead cancels", async () => {
    const { tg, dialogs, responses } = setup();
    await dialogs.handle({ type: "extension_ui_request", id: "a", method: "select", title: "Pick", options: ["x", "y"] });
    const sent = tg.of("sendMessage")[0];
    assert.equal((sent?.[2] as { disable_notification: boolean }).disable_notification, false);
    assert.deepEqual(((sent?.[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard).flat().map((b) => b.callback_data), ["d:s1:1:0", "d:s1:1:1"]);
    assert.equal(await dialogs.press(1, "1"), "y");
    assert.equal(await dialogs.press(1, "0"), "This question is closed.");
    await dialogs.handle({ type: "extension_ui_request", id: "b", method: "confirm", title: "Sure?", message: "really" });
    assert.equal(await dialogs.text("hmm"), true);
    assert.deepEqual(responses, [
      { type: "extension_ui_response", id: "a", value: "y" },
      { type: "extension_ui_response", id: "b", cancelled: true },
    ]);
  });

  test("input by force reply; notify appends to the open dialog; interrupt closes it unanswered", async () => {
    const { tg, dialogs, responses } = setup();
    await dialogs.handle({ type: "extension_ui_request", id: "i", method: "input", title: "Name?" });
    await dialogs.handle({ type: "extension_ui_request", id: "n", method: "notify", message: "fyi", notifyType: "info" });
    assert.match(String(tg.of("editMessageText").at(-1)?.[2]), /^Name\?\n\nfyi$/);
    await dialogs.interrupt();
    assert.equal(String(tg.of("editMessageText").at(-1)?.[2]), `Name?\n\nfyi\n\n${INTERRUPTED}`);
    assert.deepEqual(responses, []);
    assert.equal(dialogs.isOpen, false);
  });

  test("a move closes the dialog where it was and sends it again with the header and extra buttons", async () => {
    const tg = new FakeTg();
    const clock = new FakeClock();
    const dialogs = new Dialogs({ clock, respond: () => undefined }, "s1", { outbox: new Outbox(tg.api, 7, () => undefined, () => undefined) });
    await dialogs.handle({ type: "extension_ui_request", id: "a", method: "select", title: "Pick", options: ["x"] });
    await dialogs.moveTo({ outbox: new Outbox(tg.api, 11, () => undefined, () => undefined), header: "~/p · s", extra: [[{ text: "Attach here", callback_data: "t:s1" }]] }, "moved to background");
    assert.deepEqual(tg.of("editMessageText").at(-1)?.slice(0, 3), [7, 100, "Pick\n\nmoved to background"]);
    const resent = tg.of("sendMessage").at(-1);
    assert.equal(resent?.[0], 11);
    assert.equal(resent?.[1], "~/p · s\nPick");
    assert.deepEqual(((resent?.[2] as { reply_markup: { inline_keyboard: { text: string }[][] } }).reply_markup.inline_keyboard).flat().map((b) => b.text), ["x", "Attach here"]);
  });
});

describe("account", () => {
  const user = { name: "artem", telegramId: 1, uid: 1001, gid: 1001, git: { name: "A", email: "a@x" }, publicKeys: [] };

  function setup(): { account: Account; clock: FakeClock; tg: FakeTg; box: Outbox; helper: FakeHelper } {
    const clock = new FakeClock();
    const tg = new FakeTg();
    const helper = new FakeHelper();
    helper.providers_ = [
      { id: "openai", name: "OpenAI", loggedIn: false },
      { id: "openai-codex", name: "OpenAI Codex (legacy)", loggedIn: false },
    ];
    const account = new Account({ config: {} as Config, clock, helper, log: () => undefined, restartUser: () => undefined }, user);
    return { account, clock, tg, box: outbox(tg), helper };
  }

  async function startLogin(s: ReturnType<typeof setup>, index: number) {
    await s.account.command("login", s.box);
    await s.account.panelAction("login", String(index), s.box);
    const run = s.helper.logins.at(-1);
    assert.ok(run !== undefined);
    return run;
  }

  test("choosing another provider cancels the login in progress and starts the new one", async () => {
    const s = setup();
    const first = await startLogin(s, 0);
    const rejected = assert.rejects(first.callbacks.prompt({ type: "manual_code", message: "Paste the redirect URL" }), /cancelled/);
    await settle();
    assert.equal(s.account.quiescent, false);
    const second = await startLogin(s, 1);
    assert.equal(first.cancelled, true);
    await rejected;
    assert.equal(second.cancelled, false);
    assert.ok(s.tg.of("editMessageText").some((args) => /Paste the redirect URL\ncancelled/.test(String(args[2]))));
    assert.ok(!s.tg.of("sendMessage").some((args) => /^Error: OpenAI:/.test(String(args[1]))), "the cancelled login reports nothing");
  });

  test("a login is cancelled after 10 minutes, not before; the account is quiescent again", async () => {
    const s = setup();
    const run = await startLogin(s, 0);
    await s.clock.advance(LOGIN_TIMEOUT_MS - 1);
    assert.equal(run.cancelled, false);
    await s.clock.advance(1);
    assert.equal(run.cancelled, true);
    assert.equal(s.tg.of("sendMessage").map((args) => String(args[1])).at(-1), "Login timed out.");
    assert.equal(s.account.quiescent, true);
  });

  test("a secret being typed is dropped after 10 minutes, or by the next account command", async () => {
    const s = setup();
    await s.account.panelAction("add", undefined, s.box);
    assert.equal(s.account.quiescent, false);
    await s.clock.advance(INPUT_TIMEOUT_MS - 1);
    assert.equal(s.account.quiescent, false);
    await s.clock.advance(1);
    assert.equal(s.account.quiescent, true);
    assert.equal(String(s.tg.of("editMessageText").at(-1)?.[2]), "timed out");
    await s.account.panelAction("add", undefined, s.box);
    await s.account.command("login", s.box);
    assert.equal(s.account.quiescent, true);
    assert.equal(s.clock.pending(), 0);
  });
});

/* Agent and agents ---------------------------------------------------------- */

function agentWorld(respond?: FakePi["respond"]) {
  const clock = new FakeClock();
  const pool = new SessionPool<PiProcess>(clock, { perUser: 2, total: 4, idleMs: 30 * 60_000 });
  const pis: FakePi[] = [];
  const spawn = (spec: RpcSpec, handlers: RpcHandlers): PiProcess => {
    const pi = new FakePi(spec, handlers);
    if (respond !== undefined) pi.respond = respond;
    pis.push(pi);
    return pi;
  };
  const heard: string[] = [];
  const listener: AgentListener = {
    runStarted: (build) => heard.push(`run ${build ? "build" : "plan"}`),
    event: () => undefined,
    uiRequest: (r) => heard.push(`ui ${r.method}`),
    settled: (r) => heard.push(`settled ${r.aborted ? "aborted" : "ok"}`),
    exited: (p) => heard.push(`exited ${p === undefined ? "expected" : p.split("\n")[0]}`),
    problem: (m) => heard.push(`problem ${m}`),
    changed: () => undefined,
  };
  return { clock, pool, pis, spawn, heard, listener };
}

describe("agent deadlines and watchdog", () => {
  test("pi that does not answer get_state within 60 s is killed", async () => {
    const w = agentWorld((command) => (command.type === "get_state" ? new Promise(() => undefined) : ok(command.type)));
    const agent = new Agent({ clock: w.clock, pool: w.pool, spawn: w.spawn, log: () => undefined, exited: () => undefined }, 1, "s", "/h", "", () => ({ command: "pi", args: [], cwd: "/h", env: {} }));
    agent.listener = w.listener;
    const started = agent.start();
    await w.clock.advance(START_TIMEOUT_MS - 1);
    assert.equal(w.pis[0]?.killedWith, undefined);
    await w.clock.advance(1);
    assert.equal(w.pis[0]?.killedWith, "SIGKILL");
    assert.match((await started) ?? "", /pi did not start within 60 s/);
    assert.ok(w.heard.some((h) => /^exited pi did not answer|^exited pi did not start/.test(h)));
  });

  test("an RPC request without an answer within 60 s kills pi", async () => {
    const w = agentWorld((command) => (command.type === "set_model" ? new Promise(() => undefined) : command.type === "get_state" ? ok("get_state", {}) : ok(command.type)));
    const agent = new Agent({ clock: w.clock, pool: w.pool, spawn: w.spawn, log: () => undefined, exited: () => undefined }, 1, "s", "/h", "", () => ({ command: "pi", args: [], cwd: "/h", env: {} }));
    agent.listener = w.listener;
    const set = agent.setModel("p", "m");
    await w.clock.advance(REQUEST_TIMEOUT_MS);
    assert.equal(w.pis[0]?.killedWith, "SIGKILL");
    assert.deepEqual(await set, { problem: "could not switch the model" });
  });

  test("model silence: abort at 2:00 not 1:59, SIGKILL a minute later; a tool runs up to 60 min; an open dialog suspends it", async () => {
    const w = agentWorld();
    const agent = new Agent({ clock: w.clock, pool: w.pool, spawn: w.spawn, log: () => undefined, exited: () => undefined }, 1, "s", "/h", "", () => ({ command: "pi", args: [], cwd: "/h", env: {} }));
    agent.listener = w.listener;
    await agent.prompt({ text: "go" });
    await settle();
    const pi = w.pis[0];
    assert.ok(pi !== undefined);
    await w.clock.advance(MODEL_SILENCE_MS - 1);
    assert.ok(!pi.requests.some((r) => r.type === "abort"));
    pi.emit({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: {} });
    await w.clock.advance(TOOL_SILENCE_MS - 1);
    assert.ok(!pi.requests.some((r) => r.type === "abort"), "a tool may be silent up to 60 min");
    pi.emit({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: {}, isError: false });
    pi.ui({ type: "extension_ui_request", id: "q", method: "select", title: "?", options: ["a"] });
    await w.clock.advance(MODEL_SILENCE_MS * 5);
    assert.ok(!pi.requests.some((r) => r.type === "abort"), "waiting for the user is not silence");
    assert.equal(w.pool.isQuiescent(), true, "an open dialog keeps nothing awake");
    agent.respondUi({ type: "extension_ui_response", id: "q", value: "a" });
    await w.clock.advance(MODEL_SILENCE_MS);
    assert.ok(pi.requests.some((r) => r.type === "abort"));
    assert.ok(w.heard.includes("problem No output for 2 min: run aborted."));
    await w.clock.advance(ABORT_GRACE_MS - 1);
    assert.equal(pi.killedWith, undefined);
    await w.clock.advance(1);
    assert.equal(pi.killedWith, "SIGKILL");
  });
});

describe("agents", () => {
  function setup() {
    const w = agentWorld();
    const dir = mkdtempSync(join(tmpdir(), "agents-test-"));
    const store = new StateStore(join(dir, "state.json"));
    store.addWorkspace({ chatId: 1, kind: "private", owner: 1, title: "Direct" });
    store.addWorkspace({ chatId: -5, kind: "group", owner: 1, title: "work" });
    const gone: string[] = [];
    const agents = new Agents({ clock: w.clock, pool: w.pool, spawn: w.spawn, log: () => undefined, store, spec: () => ({ command: "pi", args: [], cwd: "/h", env: {} }), gone: (a) => gone.push(a.sessionId) });
    return { ...w, store, agents, gone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("attach displaces the agent there into the background and vacates its old workspace", async () => {
    const s = setup();
    const a = s.agents.obtain(1, "a", "/h", "");
    const b = s.agents.obtain(1, "b", "/h", "");
    await b.start();
    s.agents.attach(1, a);
    assert.deepEqual(s.agents.attach(-5, a), { displaced: undefined, vacated: 1 });
    assert.deepEqual(s.agents.attach(-5, b), { displaced: a, vacated: undefined });
    assert.equal(s.store.workspace(-5)?.agent?.sessionId, "b");
    assert.equal(s.store.workspace(1)?.agent, undefined);
    assert.deepEqual(s.gone, ["a"], "a has no process: displaced into the background, it ceases to exist");
    s.cleanup();
  });

  test("a background agent exists while its process runs; close ends any agent", async () => {
    const s = setup();
    const a = s.agents.obtain(1, "a", "/h", "");
    s.agents.attach(1, a);
    await a.start();
    s.agents.detach(1);
    assert.equal(s.agents.get("a"), a, "running in the background");
    s.pis[0]?.crash();
    await settle();
    assert.equal(s.agents.get("a"), undefined);
    assert.deepEqual(s.gone, ["a"]);
    const b = s.agents.obtain(1, "b", "/h", "");
    s.agents.attach(-5, b);
    await s.agents.close(b);
    assert.equal(s.store.workspace(-5)?.agent, undefined);
    assert.equal(s.agents.get("b"), undefined);
    assert.equal(s.agents.obtain(1, "b", "/h", "") !== b, true, "one agent per session: a closed one is not reused");
    s.cleanup();
  });

  test("an attached agent survives its process", async () => {
    const s = setup();
    const a = s.agents.obtain(1, "a", "/h", "");
    s.agents.attach(1, a);
    await a.start();
    s.pis[0]?.crash();
    await settle();
    assert.equal(s.agents.attached(1), a);
    s.cleanup();
  });
});

/* Mini App ------------------------------------------------------------------- */

describe("mini app", () => {
  const TOKEN = "123:abc";

  function sign(fields: Record<string, string>): string {
    const check = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
    return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
  }

  test("initData: a valid signature is accepted; a forged, expired or userless one is not", () => {
    const now = 1_800_000_000_000;
    const fields = { auth_date: String(now / 1000 - 60), user: JSON.stringify({ id: 42, first_name: "A" }), start_param: "w-5" };
    assert.deepEqual(verifyInitData(sign(fields), TOKEN, now), { userId: 42 });
    assert.deepEqual(verifyInitData(sign(fields).replace("w-5", "w-6"), TOKEN, now), { problem: "bad signature" });
    assert.deepEqual(verifyInitData(sign({ ...fields, auth_date: String((now - MAX_AGE_MS) / 1000 - 1) }), TOKEN, now), { problem: "expired" });
    assert.deepEqual(verifyInitData(sign({ auth_date: fields.auth_date }), TOKEN, now), { problem: "no user" });
    assert.deepEqual(verifyInitData("a=b", TOKEN, now), { problem: "no signature" });
  });

  function serve(assets: Assets, path: string, headers: Record<string, string> = {}): { status: number; headers: Record<string, string>; body: string } {
    const result = { status: 0, headers: {} as Record<string, string>, body: "" };
    const response = {
      writeHead(status: number, h?: Record<string, string>) {
        result.status = status;
        result.headers = h ?? {};
        return this;
      },
      end(body?: Buffer) {
        result.body = body?.toString() ?? "";
      },
    } as unknown as ServerResponse;
    if (!assets.serve({ headers, method: "GET" } as IncomingMessage, response, path)) result.status = 404;
    return result;
  }

  test("assets: hashed URLs immutable, index revalidated by build ETag, a new build changes both, stale URLs 404", () => {
    const dir = mkdtempSync(join(tmpdir(), "assets-test-"));
    writeFileSync(join(dir, "index.html"), '<script src="{{app.js}}"></script>');
    writeFileSync(join(dir, "app.js"), "one");
    const files = { index: join(dir, "index.html"), assets: { "app.js": join(dir, "app.js") } };
    const first = new Assets(files);
    const index = serve(first, "/app/");
    const url = /src="([^"]+)"/.exec(index.body)?.[1] ?? "";
    assert.match(url, /^\/app\/app\.[0-9a-f]{16}\.js$/);
    assert.equal(index.headers["Cache-Control"], "no-cache");
    assert.equal(index.headers.ETag, `"${first.build}"`);
    assert.match(index.headers["Content-Security-Policy"] ?? "", /script-src 'self' https:\/\/telegram\.org/);
    assert.equal(serve(first, "/app/", { "if-none-match": `"${first.build}"` }).status, 304);
    const asset = serve(first, url);
    assert.equal(asset.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(asset.body, "one");
    writeFileSync(join(dir, "app.js"), "two");
    const second = new Assets(files);
    assert.notEqual(second.build, first.build);
    assert.equal(serve(second, "/app/", { "if-none-match": `"${first.build}"` }).status, 200);
    assert.equal(serve(second, url).status, 404);
    rmSync(dir, { recursive: true, force: true });
  });
});
