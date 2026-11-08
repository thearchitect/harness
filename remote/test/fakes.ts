/**
 * Test doubles of the gateway's dependencies: a clock driven by the test, a
 * recording Bot API, a scripted pi process.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { GrammyError } from "grammy";
import type { PiProcess } from "../core/agent.ts";
import type { Clock, Timer } from "../core/clock.ts";
import type { RpcEvent, RpcHandlers, RpcRequest, RpcSpec } from "../core/rpc.ts";
import type { UserConfig } from "../config.ts";
import type { Favorite, Helper, HelperRun, History, LoginCallbacks, ModelRef, ModelSettings, Outcome, Provider, SessionInfo } from "../helper.ts";
import type { Fields, Telemetry } from "../telemetry.ts";
import type { Tg } from "../telegram/tg.ts";

/** Lets every pending promise continuation and I/O callback run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export class FakeClock implements Clock {
  private time = 1_000_000;
  private timers: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = [];
  private seq = 0;

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): Timer {
    const timer = { at: this.time + ms, seq: this.seq++, fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }

  /** Moves time forward, firing due timers in order (with the promises they start). */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await settle();
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.time = due.at;
      due.fn();
    }
    this.time = end;
    await settle();
  }

  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

export type Call = { method: string; args: unknown[]; result?: unknown };

/** A Bot API that records every call and returns plausible results. */
export class FakeTg {
  readonly calls: Call[] = [];
  private nextMessageId = 100;
  private nextThreadId = 500;
  private failures = new Map<string, Error[]>();

  /** The next call of `method` throws a Bot API error with this description. */
  failNext(method: string, description: string, code = 400): void {
    const list = this.failures.get(method) ?? [];
    list.push(new GrammyError(`Call to '${method}' failed!`, { ok: false, error_code: code, description }, method, {}));
    this.failures.set(method, list);
  }

  of(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  /** The id of the last message sent whose text matches. */
  sentId(pattern: RegExp): number | undefined {
    const call = this.calls.filter((c) => c.method === "sendMessage" && pattern.test(String(c.args[1]))).at(-1);
    return (call?.result as { message_id?: number } | undefined)?.message_id;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  get api(): Tg {
    const handler: ProxyHandler<object> = {
      get: (_target, method: string) => async (...args: unknown[]) => {
        const call: Call = { method, args };
        this.calls.push(call);
        const failure = this.failures.get(method)?.shift();
        if (failure !== undefined) throw failure;
        switch (method) {
          case "sendMessage":
          case "sendRichMessage":
          case "sendDocument":
            call.result = { message_id: this.nextMessageId++ };
            break;
          case "getFile":
            call.result = { file_id: args[0], file_path: `files/${String(args[0])}` };
            break;
          default:
            call.result = true;
        }
        return call.result;
      },
    };
    return new Proxy({}, handler) as Tg;
  }
}

/** A user helper answering from data the test sets; logins are driven by the test. */
export class FakeHelper implements Helper {
  sessions_: SessionInfo[] = [];
  histories = new Map<string, History>();
  providers_: Provider[] = [];
  readonly logins: FakeLogin[] = [];
  killedAll = false;

  login(_user: UserConfig, args: ["login" | "logout", string], callbacks: LoginCallbacks): HelperRun {
    const run = new FakeLogin(args, callbacks);
    this.logins.push(run);
    return run;
  }

  async providers(): Promise<Outcome<Provider[]>> {
    return { ok: true, data: this.providers_ };
  }

  async sessions(): Promise<Outcome<SessionInfo[]>> {
    return { ok: true, data: this.sessions_ };
  }

  async history(_user: UserConfig, _cwd: string, sessionId: string): Promise<Outcome<History>> {
    return { ok: true, data: this.histories.get(sessionId) ?? { title: "", turns: [] } };
  }

  modelSettings: ModelSettings = { available: [], favorites: [], patterns: [], default: null };
  readonly saved: { favorites: Favorite[]; default: ModelRef | null }[] = [];

  async models(): Promise<Outcome<ModelSettings>> {
    return { ok: true, data: structuredClone(this.modelSettings) };
  }

  async saveModels(_user: UserConfig, favorites: Favorite[], defaultModel: ModelRef | null): Promise<Outcome<unknown>> {
    this.saved.push({ favorites, default: defaultModel });
    this.modelSettings = { ...this.modelSettings, favorites, default: defaultModel };
    return { ok: true, data: undefined };
  }

  /** Transcriptions in progress, driven by the test. */
  readonly transcriptions: FakeTranscription[] = [];

  private waitingForTranscription: ((t: FakeTranscription) => void)[] = [];

  transcribe(_user: UserConfig, file: string, onDelta: (text: string) => void): Promise<Outcome<string>> {
    const transcription = new FakeTranscription(file, onDelta);
    this.transcriptions.push(transcription);
    for (const resolve of this.waitingForTranscription.splice(0)) resolve(transcription);
    return transcription.result;
  }

  /** Resolves with the next transcription the gateway starts (or the last one, if it started already). */
  nextTranscription(): Promise<FakeTranscription> {
    const started = this.transcriptions.at(-1);
    return started !== undefined ? Promise.resolve(started) : new Promise((resolve) => this.waitingForTranscription.push(resolve));
  }

  killAll(): void {
    this.killedAll = true;
  }
}

export class FakeTranscription {
  readonly file: string;
  readonly onDelta: (text: string) => void;
  readonly result: Promise<Outcome<string>>;
  finish!: (outcome: Outcome<string>) => void;

  constructor(file: string, onDelta: (text: string) => void) {
    this.file = file;
    this.onDelta = onDelta;
    this.result = new Promise((resolve) => (this.finish = resolve));
  }
}

/** Telemetry that records events (and errors separately). */
export class FakeTelemetry implements Telemetry {
  readonly events: { level: string; kind: string; fields: Fields }[] = [];

  info(kind: string, fields: Fields = {}): void {
    this.events.push({ level: "info", kind, fields });
  }

  warn(kind: string, fields: Fields = {}): void {
    this.events.push({ level: "warn", kind, fields });
  }

  error(kind: string, fields: Fields = {}): void {
    this.events.push({ level: "error", kind, fields });
  }

  kinds(level?: string): string[] {
    return this.events.filter((e) => level === undefined || e.level === level).map((e) => e.kind);
  }
}

export class FakeLogin implements HelperRun {
  readonly args: ["login" | "logout", string];
  readonly callbacks: LoginCallbacks;
  readonly result: Promise<Outcome<unknown>>;
  cancelled = false;
  private finish!: (outcome: Outcome<unknown>) => void;

  constructor(args: ["login" | "logout", string], callbacks: LoginCallbacks) {
    this.args = args;
    this.callbacks = callbacks;
    this.result = new Promise((resolve) => (this.finish = resolve));
  }

  cancel(): void {
    this.cancelled = true;
    this.finish({ ok: false, problem: "user helper exited (SIGKILL)" });
  }

  complete(): void {
    this.finish({ ok: true, data: undefined });
  }
}

type Responder = (command: RpcRequest) => RpcResponse | Promise<RpcResponse>;

export function ok(command: string, data?: unknown): RpcResponse {
  return { type: "response", command, success: true, data } as unknown as RpcResponse;
}

export class FakePi implements PiProcess {
  readonly requests: RpcRequest[] = [];
  readonly uiResponses: RpcExtensionUIResponse[] = [];
  readonly exited: Promise<unknown>;
  closed = false;
  readonly spec: RpcSpec;
  private readonly handlers: RpcHandlers;
  private exit!: () => void;
  respond: Responder = (command) => {
    switch (command.type) {
      case "get_state":
        return ok("get_state", { model: { provider: "deepseek", id: "deepseek-v4-pro" }, thinkingLevel: "high" });
      case "prompt":
        return ok("prompt", { disposition: "started" });
      default:
        return ok(command.type);
    }
  };

  constructor(spec: RpcSpec, handlers: RpcHandlers) {
    this.spec = spec;
    this.handlers = handlers;
    this.exited = new Promise<void>((resolve) => (this.exit = resolve));
  }

  async request(command: RpcRequest): Promise<RpcResponse> {
    this.requests.push(command);
    return this.respond(command);
  }

  respondUi(response: RpcExtensionUIResponse): void {
    this.uiResponses.push(response);
  }

  stderrTail(): string[] {
    return ["boom"];
  }

  close(): void {
    this.closed = true;
    this.exit();
  }

  kill(signal: NodeJS.Signals): void {
    this.killedWith = signal;
    this.exit();
  }

  killedWith: NodeJS.Signals | undefined;

  /** The process dies on its own. */
  crash(): void {
    this.exit();
  }

  emit(event: RpcEvent | Record<string, unknown>): void {
    this.handlers.onEvent(event as RpcEvent);
  }

  ui(request: RpcExtensionUIRequest): void {
    this.handlers.onUiRequest(request);
  }

  prompts(): string[] {
    return this.requests.filter((r) => r.type === "prompt").map((r) => (r as { message: string }).message);
  }
}
