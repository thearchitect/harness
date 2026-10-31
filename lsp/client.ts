/**
 * JSON-RPC 2.0 over the LSP base protocol (Content-Length framing) and the
 * language server process that speaks it.
 *
 * Own implementation rather than vscode-jsonrpc: the extension is loaded from
 * the Nix store without node_modules, and the protocol surface the facade
 * needs is small: requests with timeouts and cancellation, notifications, and
 * the server's requests to the client.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** An error response of the server, or a failure of the transport. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** JSON-RPC / LSP error codes the facade produces or inspects. */
export const ErrorCodes = {
  MethodNotFound: -32601,
  InternalError: -32603,
  RequestCancelled: -32800,
  ContentModified: -32801,
  RequestFailed: -32803,
} as const;

export type ConnectionHandlers = {
  /** A request of the server; the returned value (or thrown RpcError) is the response. */
  request: (method: string, params: unknown) => Promise<unknown>;
  notification: (method: string, params: unknown) => void;
};

export type RequestOptions = { timeoutMs: number; signal?: AbortSignal };

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  dispose: () => void;
};

type Message = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const HEADER_END = Buffer.from("\r\n\r\n");

export class LspConnection {
  private readonly output: Writable;
  private readonly handlers: ConnectionHandlers;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closedBy: Error | undefined;

  constructor(input: Readable, output: Writable, handlers: ConnectionHandlers) {
    this.output = output;
    this.handlers = handlers;
    input.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  request<T>(method: string, params: unknown, options: RequestOptions): Promise<T> {
    if (this.closedBy !== undefined) {
      return Promise.reject(this.closedBy);
    } else {
      const id = this.nextId++;
      return new Promise<T>((resolve, reject) => {
        const cancel = (reason: Error): void => {
          if (this.pending.delete(id)) {
            dispose();
            this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
            reject(reason);
          } else {
            // already settled
          }
        };
        const timer = setTimeout(
          () => cancel(new RpcError(`${method} timed out after ${options.timeoutMs / 1000}s`, ErrorCodes.RequestCancelled)),
          options.timeoutMs,
        );
        const onAbort = (): void => cancel(new RpcError(`${method} cancelled`, ErrorCodes.RequestCancelled));
        const dispose = (): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        if (options.signal?.aborted) {
          clearTimeout(timer);
          reject(new RpcError(`${method} cancelled`, ErrorCodes.RequestCancelled));
        } else {
          options.signal?.addEventListener("abort", onAbort, { once: true });
          this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, dispose });
          this.send({ jsonrpc: "2.0", id, method, params });
        }
      });
    }
  }

  notify(method: string, params: unknown): void {
    if (this.closedBy !== undefined) {
      throw this.closedBy;
    } else {
      this.send({ jsonrpc: "2.0", method, params });
    }
  }

  /** Fails every pending request and every later call with `reason`. Idempotent. */
  close(reason: Error): void {
    if (this.closedBy === undefined) {
      this.closedBy = reason;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.dispose();
        pending.reject(reason);
      }
    } else {
      // already closed: the first reason stands
    }
  }

  private send(message: Message): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        return;
      } else {
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const length = /Content-Length:\s*(\d+)/i.exec(header);
        if (length === null) {
          this.close(new RpcError(`malformed LSP header: ${JSON.stringify(header)}`, ErrorCodes.InternalError));
          return;
        } else {
          const start = headerEnd + HEADER_END.length;
          const end = start + Number(length[1]);
          if (this.buffer.length < end) {
            return;
          } else {
            const body = this.buffer.subarray(start, end).toString("utf8");
            this.buffer = this.buffer.subarray(end);
            this.dispatch(JSON.parse(body) as Message);
          }
        }
      }
    }
  }

  private dispatch(message: Message): void {
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      // a request of the server
      const id = message.id;
      this.handlers.request(message.method, message.params).then(
        (result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) => {
          const rpc =
            error instanceof RpcError ? error : new RpcError(error instanceof Error ? error.message : String(error), ErrorCodes.InternalError);
          this.send({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message } });
        },
      );
    } else if (message.method !== undefined) {
      this.handlers.notification(message.method, message.params);
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        // a response to a request already cancelled or timed out
      } else {
        this.pending.delete(message.id);
        pending.dispose();
        if (message.error !== undefined) {
          pending.reject(new RpcError(`${pending.method}: ${message.error.message}`, message.error.code, message.error.data));
        } else {
          pending.resolve(message.result);
        }
      }
    } else {
      // a response without a numeric id: never one of ours
    }
  }
}

export type LaunchSpec = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };
export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

const STDERR_TAIL_LINES = 40;
const STOP_STEP_MS = 2_000;

/** Process groups of every live server, killed if pi exits without a shutdown. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const pid of liveGroups) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // the group is already gone
        }
      }
    });
  } else {
    // installed by an earlier server
  }
}

/** A language server process and its connection. */
export class ServerProcess {
  readonly connection: LspConnection;
  readonly exited: Promise<ExitStatus>;
  private readonly child: ChildProcess;
  private readonly stderrLines: string[] = [];
  private exitStatus: ExitStatus | undefined;

  private constructor(child: ChildProcess, handlers: ConnectionHandlers) {
    this.child = child;
    this.connection = new LspConnection(child.stdout!, child.stdin!, handlers);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => {
      this.stderrLines.push(...text.split("\n").filter((line) => line.trim() !== ""));
      this.stderrLines.splice(0, Math.max(0, this.stderrLines.length - STDERR_TAIL_LINES));
    });
    // A write after the server died fails with EPIPE; the exit handler reports it.
    child.stdin!.on("error", () => {});
    this.exited = new Promise<ExitStatus>((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        liveGroups.delete(child.pid!);
        this.connection.close(new RpcError(`language server exited (${describeExit({ code, signal })})${this.stderrSuffix()}`, ErrorCodes.InternalError));
        resolve({ code, signal });
      });
    });
  }

  /** Spawns the server in its own process group; rejects when it cannot start at all. */
  static async spawn(spec: LaunchSpec, handlers: ConnectionHandlers): Promise<ServerProcess> {
    installExitHook();
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(new Error(`cannot start ${spec.command}: ${error.message}`)));
    });
    liveGroups.add(child.pid!);
    return new ServerProcess(child, handlers);
  }

  get running(): boolean {
    return this.exitStatus === undefined;
  }

  /** The last lines the server wrote to stderr, for error reports. */
  stderrSuffix(): string {
    if (this.stderrLines.length > 0) {
      return `; stderr:\n${this.stderrLines.join("\n")}`;
    } else {
      return "";
    }
  }

  /**
   * Orderly stop: `shutdown` + `exit`, then SIGTERM and SIGKILL to the whole
   * process group, each step bounded. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.exitStatus !== undefined) {
      return;
    } else {
      try {
        await this.connection.request("shutdown", null, { timeoutMs: STOP_STEP_MS });
        this.connection.notify("exit", null);
      } catch {
        // the server cannot take part in its shutdown: signals below
      }
      if (await this.exitsWithin(STOP_STEP_MS)) {
        return;
      } else {
        this.signalGroup("SIGTERM");
        if (await this.exitsWithin(STOP_STEP_MS)) {
          return;
        } else {
          this.signalGroup("SIGKILL");
          await this.exited;
        }
      }
    }
  }

  private async exitsWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([this.exited.then(() => true as const), timeout]);
    clearTimeout(timer);
    return result;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.child.pid!, signal);
    } catch {
      // the group is already gone
    }
  }
}

export function describeExit(status: ExitStatus): string {
  if (status.signal !== null) {
    return `signal ${status.signal}`;
  } else {
    return `code ${status.code}`;
  }
}
