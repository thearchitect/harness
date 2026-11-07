/**
 * Test doubles of the gateway's dependencies: a clock driven by the test, a
 * recording Bot API, a scripted pi process.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { GrammyError } from "grammy";
import type { Clock, Timer } from "../clock.ts";
import type { RpcEvent, RpcHandlers, RpcRequest, RpcSpec } from "../rpc.ts";
import type { PiProcess } from "../session.ts";
import type { Tg } from "../tg.ts";

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

export type Call = { method: string; args: unknown[] };

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

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  get api(): Tg {
    const handler: ProxyHandler<object> = {
      get: (_target, method: string) => async (...args: unknown[]) => {
        this.calls.push({ method, args });
        const failure = this.failures.get(method)?.shift();
        if (failure !== undefined) throw failure;
        switch (method) {
          case "sendMessage":
          case "sendRichMessage":
            return { message_id: this.nextMessageId++ };
          case "copyMessage":
            return { message_id: this.nextMessageId++ };
          case "createForumTopic":
            return { message_thread_id: this.nextThreadId++, name: args[1] };
          default:
            return true;
        }
      },
    };
    return new Proxy({}, handler) as Tg;
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

  kill(): void {
    this.exit();
  }

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
