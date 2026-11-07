/**
 * The gateway side of login-helper.ts: runs the helper as the user and turns
 * its prompts and notifications into callbacks.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identity, homeOf, userEnv } from "./accounts.ts";
import type { Config, UserConfig } from "./config.ts";

export const LOGIN_HELPER = fileURLToPath(new URL("./login-helper.ts", import.meta.url));

export type AuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export type AuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type Provider = { id: string; name: string; loggedIn: boolean };

export type LoginCallbacks = {
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
};

type HelperMessage =
  | { type: "providers"; list: Provider[] }
  | { type: "prompt"; id: string; prompt: AuthPrompt }
  | { type: "notify"; event: AuthEvent }
  | { type: "done"; ok: true }
  | { type: "done"; ok: false; error: string };

/** One run of the helper; `cancel()` stops a login in progress (the helper is killed: a browser login may wait on a socket no abort reaches). */
export class LoginRun {
  readonly result: Promise<{ ok: true; providers?: Provider[] } | { ok: false; problem: string }>;
  private readonly write: (record: object) => void;
  private readonly kill: () => void;

  constructor(config: Config, user: UserConfig, args: string[], callbacks: LoginCallbacks) {
    const child = spawn(process.execPath, [LOGIN_HELPER, ...args], {
      cwd: homeOf(config, user),
      env: userEnv(config, user),
      ...identity(config, user),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.write = (record) => {
      if (child.exitCode === null) child.stdin.write(`${JSON.stringify(record)}\n`);
    };
    this.kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    let providers: Provider[] | undefined;
    let done: { ok: true } | { ok: false; problem: string } | undefined;
    let stderr = "";
    let buffer = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim() !== "")) {
        const message = JSON.parse(line) as HelperMessage;
        switch (message.type) {
          case "providers":
            providers = message.list;
            break;
          case "prompt":
            callbacks.prompt(message.prompt).then(
              (value) => this.write({ type: "answer", id: message.id, value }),
              () => this.cancel(),
            );
            break;
          case "notify":
            callbacks.notify(message.event);
            break;
          case "done":
            done = message.ok ? { ok: true } : { ok: false, problem: message.error };
            break;
          default:
            assertNever(message);
        }
      }
    });
    this.result = new Promise((resolve) => {
      child.on("error", (error) => resolve({ ok: false, problem: error.message }));
      child.on("close", (code) => {
        if (done === undefined) {
          resolve({ ok: false, problem: stderr.trim().split("\n").slice(-3).join("\n") || `login helper exited with ${code}` });
        } else if (done.ok) {
          resolve({ ok: true, providers });
        } else {
          resolve(done);
        }
      });
    });
  }

  cancel(): void {
    this.kill();
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected helper message: ${JSON.stringify(value)}`);
}
