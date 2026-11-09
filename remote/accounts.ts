/**
 * The server-side accounts of the configured users: their home directories,
 * server SSH keys and pi settings, the environment of their processes and the
 * commands that start pi for them.
 *
 * Every file inside a home is written by a process running as that user, never
 * by root: a user's symlink cannot redirect a root write.
 *
 * The environment of a user's process is built from scratch; nothing of the
 * gateway's own environment (the bot token, the machine identity) is
 * inherited.
 */

import { spawn } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, UserConfig } from "./config.ts";
import type { RpcSpec } from "./core/rpc.ts";

export function homeOf(config: Config, user: UserConfig): string {
  return join(config.dataDir, "home", user.name);
}

/**
 * Variables of the image passed through to the user's processes: nix-ld (so
 * prebuilt binaries installed by mise and others run), mise's settings, and
 * the speech-to-text endpoint and model when the deployment overrides them.
 */
const PASSED = /^(NIX_LD|NIX_LD_LIBRARY_PATH|MISE_[A-Z_]+|SSL_CERT_FILE|TZ|HARNESS_TRANSCRIBE_(URL|MODEL))$/;

/**
 * Environment of every process the gateway starts for the user. Tools the user
 * installs (mise, uv, npm, cargo, go) land in their home, ahead of the image.
 */
export function userEnv(config: Config, user: UserConfig): Record<string, string> {
  const home = homeOf(config, user);
  const passed = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => PASSED.test(e[0]) && e[1] !== undefined));
  const own = [".local/bin", ".local/share/mise/shims", ".cargo/bin", "go/bin"].map((dir) => join(home, dir));
  return {
    ...passed,
    PATH: [...own, process.env.PATH ?? "/usr/bin:/bin"].join(":"),
    NPM_CONFIG_PREFIX: join(home, ".local"),
    UV_TOOL_BIN_DIR: join(home, ".local", "bin"),
    HOME: home,
    USER: user.name,
    LOGNAME: user.name,
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    HARNESS_PROFILE: "server",
    GIT_AUTHOR_NAME: user.git.name,
    GIT_AUTHOR_EMAIL: user.git.email,
    GIT_COMMITTER_NAME: user.git.name,
    GIT_COMMITTER_EMAIL: user.git.email,
  };
}

/** The uid/gid a process of the user runs with (none in `self` mode). */
export function identity(config: Config, user: UserConfig): { uid?: number; gid?: number } {
  switch (config.runAs) {
    case "users":
      return { uid: user.uid, gid: user.gid };
    case "self":
      return {};
    default:
      return assertNever(config.runAs);
  }
}

/** The encrypted env files of the user that exist: the deployment's, then the user's own (~/.cage). */
export function userEnvFiles(config: Config, user: UserConfig): string[] {
  return [
    join(config.paths.envsDir, `user-${user.name}.cage`),
    join(homeOf(config, user), ".cage", "store", "envs", "harness.cage"),
  ].filter((path) => existsSync(path));
}

/** How to start pi for a topic: through `cage run` when the user has secrets. */
export function piSpec(config: Config, user: UserConfig, cwd: string, sessionId: string): RpcSpec {
  const pi = ["--mode", "rpc", "--session-id", sessionId];
  const envFiles = userEnvFiles(config, user);
  const common = { cwd, env: userEnv(config, user), ...identity(config, user) };
  return envFiles.length > 0
    ? { command: config.paths.cage, args: ["run", "-raw", "-no-mask", ...envFiles, "-", config.paths.pi, ...pi], ...common }
    : { command: config.paths.pi, args: pi, ...common };
}

export type RunResult = { code: number | null; stdout: string; stderr: string };

/** Runs a command as the user in their home; `input` goes to stdin (never to argv). */
export function runAsUser(config: Config, user: UserConfig, command: string, args: string[], input?: string | Buffer): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: homeOf(config, user),
      env: userEnv(config, user),
      ...identity(config, user),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // A command that does not read its input (`[ -e f ] || cat > f` when f
    // exists) may exit first: EPIPE here, its exit status tells the outcome.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

export type ExecResult = { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string; problem?: string };

/**
 * Runs a command as the user with a deadline and a cap on its output: past
 * `timeoutMs` or `maxBytes` of stdout the process is killed and `problem`
 * says why. Binary-safe stdout.
 */
export function execAsUser(
  config: Config,
  user: UserConfig,
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; maxBytes: number; input?: Buffer | string; withSecrets?: boolean },
): Promise<ExecResult> {
  const envFiles = options.withSecrets === true ? userEnvFiles(config, user) : [];
  const [cmd, argv] = envFiles.length > 0 ? [config.paths.cage, ["run", "-raw", "-no-mask", ...envFiles, "-", command, ...args]] : [command, args];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      cwd: options.cwd ?? homeOf(config, user),
      env: userEnv(config, user),
      ...identity(config, user),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let problem: string | undefined;
    const stop = (why: string): void => {
      if (problem === undefined) {
        problem = why;
        child.kill("SIGKILL");
      } else {
        // already stopping
      }
    };
    const timer = setTimeout(() => stop(`took longer than ${options.timeoutMs / 1000} s`), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) {
        stop(`larger than ${options.maxBytes} bytes`);
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8000)));
    child.stdin.on("error", () => undefined); // exited before reading its input: the result says why
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr, problem: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(chunks), stderr, ...(problem !== undefined ? { problem } : {}) });
    });
    child.stdin.end(options.input ?? "");
  });
}

/**
 * Prepares the user's account: the home (0700, theirs), the server SSH key
 * (git over SSH, cage identity) and the initial pi settings. Idempotent: what
 * exists is kept. Resolves with the problems found (empty when ready).
 */
export async function prepareUser(config: Config, user: UserConfig): Promise<string[]> {
  const home = homeOf(config, user);
  const problems: string[] = [];
  {
    // The homes' parent is traversable by everyone; each home is its user's only.
    const homes = dirname(home);
    mkdirSync(homes, { recursive: true, mode: 0o755 });
    chmodSync(homes, 0o755);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (config.runAs === "users") {
      const stat = statSync(home);
      if (stat.uid !== user.uid) chownSync(home, user.uid, user.gid);
      chmodSync(home, 0o700);
    } else {
      // self: the gateway's own user owns the home it creates
    }
  }
  {
    const key = await runAsUser(config, user, "sh", [
      "-c",
      'umask 077; mkdir -p .ssh; [ -f .ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "$1" -f .ssh/id_ed25519',
      "sh",
      `${user.name}@${process.env.FLY_APP_NAME ?? "harness-remote"}`,
    ]);
    if (key.code !== 0) problems.push(`server SSH key: ${key.stderr.trim() || `exit ${key.code}`}`);
  }
  {
    const settings = await runAsUser(
      config,
      user,
      "sh",
      ["-c", "umask 077; mkdir -p .pi/agent; [ -e .pi/agent/settings.json ] || cat > .pi/agent/settings.json"],
      `${JSON.stringify(config.defaultSettings, null, 2)}\n`,
    );
    if (settings.code !== 0) problems.push(`pi settings: ${settings.stderr.trim() || `exit ${settings.code}`}`);
  }
  return problems;
}

/** The user's public server key (`ssh-ed25519 … name@app`), or undefined while it does not exist. */
export async function publicKey(config: Config, user: UserConfig): Promise<string | undefined> {
  const result = await runAsUser(config, user, "cat", [".ssh/id_ed25519.pub"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
