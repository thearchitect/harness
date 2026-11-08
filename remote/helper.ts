/**
 * The gateway side of user-helper.ts: runs the helper as the user, turns its
 * prompts and notifications into callbacks, and owns every helper process:
 * queries end at QUERY_TIMEOUT_MS, logins when the account cancels them, all
 * of them when the gateway stops.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identity, homeOf, userEnv, userEnvFiles } from "./accounts.ts";
import type { Config, UserConfig } from "./config.ts";
import type { Clock } from "./core/clock.ts";

export const USER_HELPER = fileURLToPath(new URL("./user-helper.ts", import.meta.url));

/** Deadline of a query (providers, sessions, history). */
export const QUERY_TIMEOUT_MS = 30_000;

export type AuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export type AuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type Provider = { id: string; name: string; loggedIn: boolean };
export type ModelRef = { provider: string; id: string };
export type Favorite = ModelRef & { effort?: string };
/** The user's model settings in pi: favorites (enabledModels) with their effort, the default model. */
export type ModelSettings = {
  available: (ModelRef & { name: string; levels: string[] })[];
  favorites: Favorite[];
  /** enabledModels entries that are patterns: kept, shown read-only. */
  patterns: string[];
  default: ModelRef | null;
};

/** Deadline of a transcription. */
export const TRANSCRIBE_TIMEOUT_MS = 2 * 60_000;
export type SessionInfo = { id: string; cwd: string; title: string; modified: number };
export type Turn = { prompt: string; answer: string };
export type History = { title: string; turns: Turn[] };

export type LoginCallbacks = {
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
};

type HelperMessage =
  | { type: "providers"; list: Provider[] }
  | { type: "sessions"; list: SessionInfo[] }
  | { type: "history"; title: string; turns: Turn[] }
  | { type: "models"; models: ModelSettings }
  | { type: "delta"; text: string }
  | { type: "transcript"; text: string }
  | { type: "prompt"; id: string; prompt: AuthPrompt }
  | { type: "notify"; event: AuthEvent }
  | { type: "done"; ok: true }
  | { type: "done"; ok: false; error: string };

export type Outcome<T> = { ok: true; data: T } | { ok: false; problem: string };

/** One run of the helper; `cancel()` kills it (a browser login may wait on a socket no abort reaches). */
export type HelperRun = {
  readonly result: Promise<Outcome<unknown>>;
  cancel(): void;
};

export type Helper = {
  login(user: UserConfig, args: ["login" | "logout", string], callbacks: LoginCallbacks): HelperRun;
  providers(user: UserConfig): Promise<Outcome<Provider[]>>;
  sessions(user: UserConfig): Promise<Outcome<SessionInfo[]>>;
  history(user: UserConfig, cwd: string, sessionId: string, turns: number): Promise<Outcome<History>>;
  models(user: UserConfig): Promise<Outcome<ModelSettings>>;
  saveModels(user: UserConfig, favorites: Favorite[], defaultModel: ModelRef | null): Promise<Outcome<unknown>>;
  /** Speech to text of a file in the user's home; `onDelta` gets the text as it comes. */
  transcribe(user: UserConfig, file: string, onDelta: (text: string) => void): Promise<Outcome<string>>;
  /** Kills every helper still running (the gateway stops). */
  killAll(): void;
};

export function createHelper(config: Config, clock: Clock): Helper {
  const running = new Set<() => void>();

  function run(user: UserConfig, args: string[], callbacks: LoginCallbacks | undefined, options: { withSecrets?: boolean; onDelta?: (text: string) => void } = {}): HelperRun {
    const envFiles = options.withSecrets === true ? userEnvFiles(config, user) : [];
    const [command, argv] = envFiles.length > 0
      ? [config.paths.cage, ["run", "-raw", "-no-mask", ...envFiles, "-", process.execPath, USER_HELPER, ...args]]
      : [process.execPath, [USER_HELPER, ...args]];
    const child = spawn(command, argv, {
      cwd: homeOf(config, user),
      env: userEnv(config, user),
      ...identity(config, user),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    running.add(kill);
    const write = (record: object): void => {
      if (child.exitCode === null) child.stdin.write(`${JSON.stringify(record)}\n`);
    };
    let data: unknown;
    let done: { ok: true } | { ok: false; problem: string } | undefined;
    let stderr = "";
    let buffer = "";
    child.stdin.on("error", () => undefined); // the helper exited: its result says why
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim() !== "")) {
        const message = JSON.parse(line) as HelperMessage;
        switch (message.type) {
          case "providers":
          case "sessions":
            data = message.list;
            break;
          case "history":
            data = { title: message.title, turns: message.turns };
            break;
          case "models":
            data = message.models;
            break;
          case "delta":
            options.onDelta?.(message.text);
            break;
          case "transcript":
            data = message.text;
            break;
          case "prompt":
            if (callbacks === undefined) {
              kill(); // a query never prompts
            } else {
              callbacks.prompt(message.prompt).then((value) => write({ type: "answer", id: message.id, value }), kill);
            }
            break;
          case "notify":
            callbacks?.notify(message.event);
            break;
          case "done":
            done = message.ok ? { ok: true } : { ok: false, problem: message.error };
            break;
          default:
            assertNever(message);
        }
      }
    });
    const result = new Promise<Outcome<unknown>>((resolve) => {
      child.on("error", (error) => {
        running.delete(kill);
        resolve({ ok: false, problem: error.message });
      });
      child.on("close", (code, signal) => {
        running.delete(kill);
        if (done === undefined) {
          resolve({ ok: false, problem: stderr.trim().split("\n").slice(-3).join("\n") || `user helper exited (${signal ?? code})` });
        } else if (done.ok) {
          resolve({ ok: true, data });
        } else {
          resolve(done);
        }
      });
    });
    return { result, cancel: kill };
  }

  async function query<T>(user: UserConfig, args: string[], options: { withSecrets?: boolean; onDelta?: (text: string) => void; timeoutMs?: number } = {}): Promise<Outcome<T>> {
    const helper = run(user, args, undefined, options);
    const limit = options.timeoutMs ?? QUERY_TIMEOUT_MS;
    let timedOut = false;
    const timer = clock.after(limit, () => {
      timedOut = true;
      helper.cancel();
    });
    const outcome = await helper.result;
    timer.cancel();
    return timedOut ? { ok: false, problem: `${args[0]} took longer than ${limit / 1000} s` } : (outcome as Outcome<T>);
  }

  return {
    login: (user, args, callbacks) => run(user, args, callbacks),
    providers: (user) => query<Provider[]>(user, ["providers"]),
    sessions: (user) => query<SessionInfo[]>(user, ["sessions"]),
    history: (user, cwd, sessionId, turns) => query<History>(user, ["history", cwd, sessionId, String(turns)]),
    models: (user) => query<ModelSettings>(user, ["models"], { withSecrets: true }),
    saveModels: (user, favorites, defaultModel) => query<unknown>(user, ["models-save", JSON.stringify({ favorites, default: defaultModel })]),
    transcribe: (user, file, onDelta) => query<string>(user, ["transcribe", file], { onDelta, timeoutMs: TRANSCRIBE_TIMEOUT_MS }),
    killAll: () => {
      for (const kill of [...running]) kill();
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`unexpected helper message: ${JSON.stringify(value)}`);
}
