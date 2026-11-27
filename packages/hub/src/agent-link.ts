// One harness-agent process and its HAP stream. The hub writes requests and commands to it and
// fans its records out: responses go to the connection that asked (ids are rewritten per
// connection, so two clients' ids never collide), everything else to every attached connection.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import type { SubagentLaunch } from "#protocol/state.ts";

export type AgentRecord = { type?: unknown; id?: unknown; [key: string]: unknown };

export type AgentLaunch = {
  /** The agent's command line: an executable and its first arguments. */
  command: string[];
  cwd: string;
  sessionFile?: string;
  parentSession?: string;
  /** The child's subagent launch (passed as --subagent JSON). */
  subagent?: SubagentLaunch;
  env: Record<string, string | undefined>;
  logPath: string;
};

export class AgentLink {
  readonly process: ChildProcess;
  private readonly stream: Duplex;
  private readonly listeners = new Set<(record: AgentRecord) => void>();
  private readonly exitListeners = new Set<(code: number | null, error?: string) => void>();
  private exited = false;

  constructor(launch: AgentLaunch) {
    mkdirSync(dirname(launch.logPath), { recursive: true });
    const log = createWriteStream(launch.logPath, { flags: "a" });
    const [executable, ...prefix] = launch.command;
    if (executable === undefined) {
      throw new Error("the agent command is empty");
    } else {
      const args = [
        ...prefix,
        "--cwd",
        launch.cwd,
        ...(launch.sessionFile !== undefined ? ["--session-file", launch.sessionFile] : []),
        ...(launch.parentSession !== undefined ? ["--parent-session", launch.parentSession] : []),
        ...(launch.subagent !== undefined ? ["--subagent", JSON.stringify(launch.subagent)] : []),
      ];
      this.process = spawn(executable, args, { cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
      this.process.stdout?.pipe(log, { end: false });
      this.process.stderr?.pipe(log, { end: false });
      const stream = this.process.stdio[3];
      if (stream === null || stream === undefined) {
        throw new Error("the agent has no HAP stream");
      } else {
        this.stream = stream as Duplex;
      }
      const decoder = new LineDecoder();
      this.stream.on("data", (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          const decoded = decodeRecord(line);
          if (decoded.ok) {
            for (const listener of this.listeners) {
              listener(decoded.record);
            }
          } else {
            log.write(`[node] malformed record from the agent: ${decoded.error}\n`);
          }
        }
      });
      this.stream.on("error", () => {
        // the agent closed its end: "exit" reports why
      });
      this.process.on("error", (error) => this.finish(null, error.message, log));
      this.process.on("exit", (code) => this.finish(code, undefined, log));
    }
  }

  private finish(code: number | null, error: string | undefined, log: NodeJS.WritableStream): void {
    if (this.exited) {
      return; // "error" and "exit" can both arrive
    } else {
      this.exited = true;
      log.end();
      for (const listener of this.exitListeners) {
        listener(code, error);
      }
    }
  }

  get alive(): boolean {
    return !this.exited;
  }

  onRecord(listener: (record: AgentRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (code: number | null, error?: string) => void): void {
    this.exitListeners.add(listener);
  }

  send(record: object): void {
    if (this.exited) {
      throw new Error("the agent has exited");
    } else {
      this.stream.write(encodeRecord(record));
    }
  }

  /** Ends the stream (the agent shuts down on EOF); SIGTERM, then SIGKILL, if it does not exit in time. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.exited) {
      return;
    } else {
      const exited = new Promise<void>((resolve) => this.onExit(() => resolve()));
      this.stream.end();
      const term = setTimeout(() => this.process.kill("SIGTERM"), graceMs);
      const kill = setTimeout(() => this.process.kill("SIGKILL"), graceMs * 2);
      await exited;
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}
