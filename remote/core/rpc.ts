/**
 * One `pi --mode rpc` process: JSONL commands on stdin, responses, session
 * events and extension UI requests on stdout.
 *
 * pi's own RpcClient does not fit the gateway: it inherits the parent's
 * environment (the bot token would leak to the agent), cannot switch uid and
 * does not answer extension UI requests. This client starts exactly the given
 * command with exactly the given environment, in its own process group.
 *
 * Framing follows pi's docs/json.md: records end with LF only (an optional CR
 * before it is stripped); U+2028/U+2029 inside JSON strings are not
 * boundaries, so Node's readline is not used.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

/** A command as the caller writes it; the client assigns the id. */
export type RpcRequest = RpcCommand extends infer C ? (C extends { id?: string } ? Omit<C, "id"> : never) : never;

export type RpcEvent = JsonAgentSessionEvent | { type: "extension_error"; extensionPath: string; event: string; error: string };

export type RpcExit = { code: number | null; signal: NodeJS.Signals | null };

export type RpcSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
};

export type RpcHandlers = {
  onEvent(event: RpcEvent): void;
  onUiRequest(request: RpcExtensionUIRequest): void;
  /** A diagnostic line: stderr of pi, an unparsable stdout record. */
  onLog(line: string): void;
};

const STDERR_TAIL = 50;

export class RpcProcess {
  readonly exited: Promise<RpcExit>;
  private readonly child: ChildProcess;
  private readonly handlers: RpcHandlers;
  private readonly pending = new Map<string, { resolve(response: RpcResponse): void; reject(error: Error): void }>();
  private readonly stderrLines: string[] = [];
  private nextId = 1;
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private stderrBuffer = "";
  private exit: RpcExit | undefined;

  constructor(spec: RpcSpec, handlers: RpcHandlers) {
    this.handlers = handlers;
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      uid: spec.uid,
      gid: spec.gid,
      detached: true, // own process group: kill() reaches pi and its tools
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.stdin?.on("error", (error) => handlers.onLog(`stdin: ${error.message}`));
    this.exited = new Promise((resolve) => {
      this.child.on("error", (error) => {
        handlers.onLog(`spawn failed: ${error.message}`);
        this.finish({ code: null, signal: null }, resolve);
      });
      this.child.on("close", (code, signal) => this.finish({ code, signal }, resolve));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exit === undefined;
  }

  /** Last lines pi wrote to stderr: the context of an unexpected exit. */
  stderrTail(): string[] {
    return [...this.stderrLines];
  }

  /** Sends a command and resolves with its response (success or not); rejects when pi exits first. */
  request(command: RpcRequest): Promise<RpcResponse> {
    const id = `g${this.nextId++}`;
    return new Promise((resolve, reject) => {
      if (this.exit !== undefined) {
        reject(new Error("pi has exited"));
      } else {
        this.pending.set(id, { resolve, reject });
        this.write({ ...command, id });
      }
    });
  }

  respondUi(response: RpcExtensionUIResponse): void {
    this.write(response);
  }

  /** Closes stdin: pi's orderly shutdown. */
  close(): void {
    this.child.stdin?.end();
  }

  /** Signals the whole process group. */
  kill(signal: NodeJS.Signals): void {
    if (this.exit === undefined && this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, signal);
      } catch (error) {
        this.handlers.onLog(`kill ${signal}: ${(error as Error).message}`);
      }
    } else {
      // already exited: nothing to signal
    }
  }

  private write(record: object): void {
    if (this.exit === undefined) {
      this.child.stdin?.write(`${JSON.stringify(record)}\n`);
    } else {
      this.handlers.onLog(`dropped a record after exit: ${JSON.stringify(record).slice(0, 200)}`);
    }
  }

  private onStdout(chunk: Buffer): void {
    let buffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a)) {
      const end = newline > 0 && buffer[newline - 1] === 0x0d ? newline - 1 : newline;
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      if (line.trim() !== "") {
        this.onRecord(line);
      } else {
        // blank line: nothing to dispatch
      }
    }
    this.stdoutBuffer = buffer;
  }

  private onRecord(line: string): void {
    let record: { type?: unknown; id?: unknown };
    try {
      record = JSON.parse(line) as { type?: unknown; id?: unknown };
    } catch {
      this.handlers.onLog(`unparsable stdout record: ${line.slice(0, 200)}`);
      return;
    }
    if (record.type === "response") {
      const waiter = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
      if (waiter !== undefined) {
        this.pending.delete(record.id as string);
        waiter.resolve(record as RpcResponse);
      } else {
        this.handlers.onLog(`response without a request: ${line.slice(0, 200)}`);
      }
    } else if (record.type === "extension_ui_request") {
      this.handlers.onUiRequest(record as RpcExtensionUIRequest);
    } else {
      this.handlers.onEvent(record as RpcEvent);
    }
  }

  private onStderr(chunk: string): void {
    const lines = (this.stderrBuffer + chunk).split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_TAIL) this.stderrLines.shift();
      this.handlers.onLog(line);
    }
  }

  private finish(exit: RpcExit, resolve: (exit: RpcExit) => void): void {
    if (this.exit !== undefined) return; // "error" and "close" may both fire
    this.exit = exit;
    for (const waiter of this.pending.values()) waiter.reject(new Error(`pi exited (code ${exit.code}, signal ${exit.signal})`));
    this.pending.clear();
    resolve(exit);
  }
}
