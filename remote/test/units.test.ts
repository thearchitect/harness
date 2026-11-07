/**
 * Unit tests of the gateway's pure and timer-driven parts:
 * config, dotenv, render, card, pool, idle shutdown, outbox, run view, dialogs.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { modelsPanel, morePanel, renderSessionCard, REPLY_KEYBOARD, sectionOf } from "../card.ts";
import { parseConfig } from "../config.ts";
import { Dialogs } from "../dialogs.ts";
import { parseDotenv } from "../dotenv.ts";
import { IdleShutdown } from "../idle.ts";
import { Outbox } from "../outbox.ts";
import { SessionPool, type PoolProcess } from "../pool.ts";
import { bannerLine, fence, type Item, MESSAGE_LIMIT, renderDraft, renderItems, splitText, stripAnsi, toolSummary } from "../render.ts";
import { RunView } from "../stream.ts";
import { GATE_OPTIONS, GATE_TITLE, GATE_COMMENT_PROMPTS } from "../../rpc-dialogs.ts";
import { FakeClock, FakeTg, settle } from "./fakes.ts";

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

  test("items: thinking and tools collapsed, text as is, ANSI stripped", () => {
    const items: Item[] = [
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "\u001b[31mHello\u001b[0m" },
      { kind: "tool", id: "1", name: "bash", args: { command: "ls -la" }, result: "x".repeat(3100), isError: true, durationMs: 1500, done: true },
    ];
    const out = renderItems(items);
    assert.match(out, /^<details><summary>💭 Thinking<\/summary>\n\nhmm\n\n<\/details>\n\nHello\n\n<details><summary>❌ bash: ls -la · 2s<\/summary>/);
    assert.match(out, /… 100 more chars/);
  });

  test("tool summaries pick the meaningful argument and stay short", () => {
    assert.equal(toolSummary("read", { path: "src/a.ts", limit: 3 }), "read: src/a.ts");
    assert.equal(toolSummary("x", { a: 1 }), 'x: {"a":1}');
    assert.equal(toolSummary("bash", { command: "y".repeat(200) }).length, 80);
  });

  test("long text splits at line boundaries below the limit", () => {
    const parts = splitText(`${"a".repeat(60)}\n${"b".repeat(60)}`, 100);
    assert.deepEqual(parts, ["a".repeat(60), "b".repeat(60)]);
    assert.ok(splitText("z".repeat(MESSAGE_LIMIT * 2 + 5), MESSAGE_LIMIT).every((p) => p.length <= MESSAGE_LIMIT));
  });

  test("draft: header, tail, activity", () => {
    const draft = renderDraft("📝 Planning · 3s", [{ kind: "text", text: "partial" }], "⏳ bash: ls");
    assert.equal(draft, "**📝 Planning · 3s**\n\npartial\n\n_⏳ bash: ls_");
  });

  test("banner", () => {
    assert.equal(bannerLine({ mode: "plan", durationMs: 134_000, costUsd: 0.1234, model: "deepseek/deepseek-v4-pro" }), "✅ planning finished · 2m 14s · $0.12 · deepseek-v4-pro");
    assert.equal(bannerLine({ mode: "normal", interrupted: true }), "⏹ building interrupted");
    assert.equal(stripAnsi("\u001b[1mx\u001b[0m"), "x");
  });
});

describe("cards and panels", () => {
  test("the status card is one line of text", () => {
    const base = { dir: "~/showone", model: "deepseek/deepseek-v4-pro", thinking: "max", nextMode: "plan" as const };
    assert.equal(renderSessionCard({ ...base, status: { kind: "idle" } }, 0), "📁 <b>~/showone</b> · 🧠 deepseek-v4-pro · 💭 max · 📝 Plan · ● idle");
    assert.match(renderSessionCard({ ...base, nextMode: "build", status: { kind: "running", since: 0 } }, 72_000), /🔨 Build next · ⏳ running 1m 12s$/);
  });

  test("the keyboard: four sections; a press is recognized by its exact text", () => {
    assert.deepEqual(REPLY_KEYBOARD.keyboard[0]?.map((b) => (typeof b === "string" ? b : b.text)), ["🔨 Build", "⏹ Stop", "🧠 Model", "⚙️ More"]);
    assert.equal(REPLY_KEYBOARD.is_persistent, true);
    assert.equal(sectionOf("🧠 Model"), "model");
    assert.equal(sectionOf("🧠 Model please"), undefined);
  });

  test("model list pages", () => {
    const models = Array.from({ length: 10 }, (_, i) => ({ provider: "p", id: `m${i}` }));
    const page1 = modelsPanel(models, 1, "p/m9");
    assert.deepEqual(page1.keyboard.map((row) => row.map((b) => b.text)), [["p/m8"], ["✓ p/m9"], ["‹", "✕"]]);
    assert.equal(page1.html, "🧠 <b>Model</b> (2/2)");
  });

  test("⚙️ More: session actions only in a session topic", () => {
    const data = (inSession: boolean): string[] => morePanel(inSession).keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
    assert.deepEqual(data(true).slice(0, 3), ["s:thinking", "s:compact", "s:close"]);
    assert.ok(!data(false).includes("s:thinking"));
    assert.ok(data(false).includes("a:providers"));
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
  return new Outbox(tg.api, 7, 9, () => undefined, gone);
}

describe("outbox", () => {
  test("a transient keyboard loses its buttons when anything is posted below", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    const id = await box.send({ html: "plan done" }, { role: "transient", keyboard: [[{ text: "Build", callback_data: "r:build" }]] });
    await box.send({ html: "next" });
    assert.deepEqual(tg.methods(), ["sendMessage", "editMessageReplyMarkup", "sendMessage"]);
    assert.deepEqual(tg.of("editMessageReplyMarkup")[0]?.slice(0, 2), [7, id]);
  });

  test("a sticky dialog is re-sent below newer messages and stays last", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    const dialog = await box.send({ html: "Allow?" }, { role: "sticky", keyboard: [[{ text: "Yes", callback_data: "d:1:allow" }]] });
    await box.send({ html: "notice" });
    assert.deepEqual(tg.methods(), ["sendMessage", "sendMessage", "deleteMessage", "sendMessage"]);
    assert.deepEqual(tg.of("deleteMessage")[0], [7, dialog]);
    assert.equal(tg.of("sendMessage")[2]?.[1], "Allow?");
    await box.userPosted();
    assert.deepEqual(tg.methods().slice(4), ["deleteMessage", "sendMessage"]);
    await box.closeSticky({ html: "Allow?\n\n✅ allowed" });
    await box.send({ html: "after" });
    assert.deepEqual(tg.methods().slice(6), ["editMessageText", "sendMessage"], "a closed dialog no longer moves");
  });

  test("pinned cards move nothing; edits of unchanged text are not errors", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    await box.send({ html: "t" }, { role: "transient", keyboard: [[{ text: "x", callback_data: "x" }]] });
    await box.send({ html: "card" }, { role: "pinned", keyboard: [[{ text: "y", callback_data: "y" }]] });
    tg.failNext("editMessageText", "Bad Request: message is not modified");
    await box.edit(101, { html: "card" });
    assert.deepEqual(tg.methods(), ["sendMessage", "sendMessage", "editMessageText"]);
  });

  test("a panel is edited in place while it is the last message, re-posted below otherwise, closed with its outcome", async () => {
    const tg = new FakeTg();
    const box = outbox(tg);
    await box.showPanel({ html: "page 1", keyboard: [[{ text: "›", callback_data: "s:models:1" }]] });
    const panelId = tg.of("sendMessage")[0] !== undefined ? 100 : -1;
    assert.equal(box.ownsPanel(panelId), true);
    await box.showPanel({ html: "page 2", keyboard: [[{ text: "‹", callback_data: "s:models:0" }]] });
    assert.deepEqual(tg.methods(), ["sendMessage", "editMessageText"]);
    await box.userPosted();
    assert.equal(box.ownsPanel(panelId), false, "a message below retires the panel");
    await box.showPanel({ html: "again", keyboard: [[{ text: "x", callback_data: "s:dismiss" }]] });
    assert.deepEqual(tg.methods().slice(2), ["editMessageReplyMarkup", "sendMessage"]);
    await box.closePanel("🧠 p/m1 ✓");
    assert.deepEqual(tg.of("editMessageText").at(-1)?.slice(1, 3), [101, "🧠 p/m1 ✓"]);
    await box.showPanel({ html: "more", keyboard: [[{ text: "✕", callback_data: "s:dismiss" }]] });
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

  test("a deleted topic is reported once and silences the outbox", async () => {
    const tg = new FakeTg();
    let gone = 0;
    const box = outbox(tg, () => gone++);
    tg.failNext("sendMessage", "Bad Request: message thread not found");
    await box.send({ html: "a" });
    await box.send({ html: "b" });
    assert.equal(gone, 1);
    assert.equal(tg.of("sendMessage").length, 1);
  });
});

describe("run view", () => {
  test("draft at most once a second on new content, keepalive within 20 s, typing every 4 s", async () => {
    const clock = new FakeClock();
    const tg = new FakeTg();
    const view = new RunView(outbox(tg), clock, "Planning", 42);
    await clock.advance(0);
    assert.equal(tg.of("sendRichMessageDraft").length, 1);
    view.onEvent({ type: "message_start", message: {} } as never);
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as never);
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } } as never);
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } } as never);
    await clock.advance(999);
    assert.equal(tg.of("sendRichMessageDraft").length, 1, "throttled");
    await clock.advance(1);
    const drafts = tg.of("sendRichMessageDraft");
    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts[1]?.slice(1, 4), [42, { markdown: "**📝 Planning · 1s**\n\nHello" }, { message_thread_id: 9, can_stop: true }]);
    await clock.advance(20_000);
    assert.equal(tg.of("sendRichMessageDraft").length, 3, "keepalive");
    assert.equal(tg.of("sendChatAction").length, 6, "typing at 0, 4, 8, 12, 16, 20 s");
  });

  test("pause commits and stops the draft; finish sends the rest with the banner and buttons, with sound", async () => {
    const clock = new FakeClock();
    const tg = new FakeTg();
    const box = outbox(tg);
    const view = new RunView(box, clock, "Planning", 1);
    view.onEvent({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" } } as never);
    view.onEvent({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] }, isError: false, durationMs: 10 } as never);
    await view.pause();
    const committed = tg.of("sendRichMessage");
    assert.equal(committed.length, 1);
    assert.match((committed[0]?.[1] as { markdown: string }).markdown, /<summary>🔧 bash: ls · 0s<\/summary>/);
    const before = tg.of("sendRichMessageDraft").length;
    await clock.advance(30_000);
    assert.equal(tg.of("sendRichMessageDraft").length, before, "no drafts while paused");
    view.resume();
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as never);
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Done." } } as never);
    await view.finish("✅ planning finished", [[{ text: "🔨 Build", callback_data: "r:build" }]]);
    const final = tg.of("sendRichMessage")[1];
    assert.deepEqual(final?.[1], { markdown: "Done.\n\n✅ planning finished" });
    assert.equal((final?.[2] as { disable_notification: boolean }).disable_notification, false);
    assert.equal(clock.pending(), 0, "no timers after finish");
  });

  test("a large turn is committed at the turn boundary", async () => {
    const clock = new FakeClock();
    const tg = new FakeTg();
    const view = new RunView(outbox(tg), clock, "Building", 1);
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as never);
    view.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(13_000) } } as never);
    assert.equal(tg.of("sendRichMessage").length, 0);
    view.onEvent({ type: "turn_end" } as never);
    await settle();
    assert.equal(tg.of("sendRichMessage").length, 1);
    view.dispose();
  });
});

describe("dialogs", () => {
  function harness(): { dialogs: Dialogs; tg: FakeTg; responses: unknown[]; events: string[] } {
    const tg = new FakeTg();
    const responses: unknown[] = [];
    const events: string[] = [];
    const dialogs = new Dialogs({
      outbox: outbox(tg),
      clock: new FakeClock(),
      respond: (r) => responses.push(r),
      opened: async () => void events.push("opened"),
      closed: () => void events.push("closed"),
    });
    return { dialogs, tg, responses, events };
  }
  const gate = { type: "extension_ui_request", id: "g1", method: "select", title: `${GATE_TITLE}\nedit a.ts\n+x`, options: Object.values(GATE_OPTIONS) } as const;

  test("the gate as buttons; Allow answers at once", async () => {
    const { dialogs, tg, responses, events } = harness();
    await dialogs.handle({ ...gate, options: [...gate.options] });
    const [, html, options] = tg.of("sendMessage")[0] ?? [];
    assert.equal(html, "✏️ <b>Allow file change?</b>\n<pre>edit a.ts\n+x</pre>");
    assert.deepEqual((options as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ["d:1:allow", "d:1:note", "d:1:reject", "d:1:stop"]);
    assert.equal(await dialogs.press(1, "allow"), "Allowed");
    assert.deepEqual(responses, [{ type: "extension_ui_response", id: "g1", value: "Allow" }]);
    assert.deepEqual(events, ["opened", "closed"]);
    assert.equal(await dialogs.press(1, "allow"), "This question is closed.");
  });

  test("text instead of a button rejects with that comment; the follow-up input is answered by the gateway", async () => {
    const { dialogs, responses } = harness();
    await dialogs.handle({ ...gate, options: [...gate.options] });
    assert.equal(await dialogs.text("wrong file"), true);
    await dialogs.handle({ type: "extension_ui_request", id: "c1", method: "input", title: GATE_COMMENT_PROMPTS.rejectWithComment });
    assert.deepEqual(responses, [
      { type: "extension_ui_response", id: "g1", value: "Reject with comment" },
      { type: "extension_ui_response", id: "c1", value: "wrong file" },
    ]);
    assert.equal(dialogs.isOpen, false);
  });

  test("Allow + note asks for the note, then allows with it", async () => {
    const { dialogs, responses } = harness();
    await dialogs.handle({ ...gate, options: [...gate.options] });
    await dialogs.press(1, "note");
    await dialogs.text("keep it short");
    await dialogs.handle({ type: "extension_ui_request", id: "c1", method: "input", title: GATE_COMMENT_PROMPTS.allowWithComment });
    assert.deepEqual(responses.map((r) => (r as { value: string }).value), ["Allow with comment", "keep it short"]);
  });

  test("other dialogs: select, confirm, input; cancel; notify appends to the open dialog", async () => {
    const { dialogs, tg, responses } = harness();
    await dialogs.handle({ type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["a", "b"] });
    await dialogs.handle({ type: "extension_ui_request", id: "n", method: "notify", message: "fyi" });
    assert.match(String(tg.of("editMessageText")[0]?.[2]), /❓ Pick\n\nfyi/);
    assert.equal(await dialogs.press(1, "1"), "b");
    await dialogs.handle({ type: "extension_ui_request", id: "c", method: "confirm", title: "Sure?", message: "really" });
    await dialogs.press(2, "no");
    await dialogs.handle({ type: "extension_ui_request", id: "i", method: "input", title: "Name?" });
    await dialogs.text("Bob");
    await dialogs.handle({ type: "extension_ui_request", id: "x", method: "select", title: "Again", options: ["a"] });
    await dialogs.cancel();
    assert.deepEqual(responses, [
      { type: "extension_ui_response", id: "s", value: "b" },
      { type: "extension_ui_response", id: "c", confirmed: false },
      { type: "extension_ui_response", id: "i", value: "Bob" },
      { type: "extension_ui_response", id: "x", cancelled: true },
    ]);
  });
});
