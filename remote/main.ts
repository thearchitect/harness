/**
 * harness-telegram: the Telegram gateway of a remote harness deployment.
 *
 *   harness-telegram <config.json|remote.yaml>
 *
 * Start: configuration → machine identity → machine secrets (bot token,
 * webhook secret; decrypted with cage into memory) → bot checks (topics in
 * private chats must be on) → webhook → user accounts → HTTP endpoint.
 * Stop: SIGTERM/SIGINT (deploy) interrupt running runs with a notice; when
 * nothing has happened for a while and nothing waits, the gateway exits 0 and
 * the machine stops until the next webhook wakes it.
 */

import { spawn } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import { prepareUser, piSpec } from "./accounts.ts";
import { BOT_COMMANDS, Gateway } from "./bot.ts";
import { systemClock } from "./clock.ts";
import { parseConfig, type Config } from "./config.ts";
import { parseDotenv } from "./dotenv.ts";
import { IdleShutdown } from "./idle.ts";
import { LoginRun } from "./login.ts";
import { SessionPool } from "./pool.ts";
import { RpcProcess } from "./rpc.ts";
import { startWebhookServer } from "./server.ts";
import type { Update } from "grammy/types";
import type { PiProcess } from "./session.ts";
import { StateStore } from "./state.ts";

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "stopped_message_generation"] as const;

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function fail(message: string): never {
  log(`fatal: ${message}`);
  process.exit(1);
}

function machineSecrets(config: Config): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.paths.cage, ["dump", "-o", "/dev/stdout", join(config.paths.envsDir, "machine.cage")], {
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", CAGE_SSH_IDENTITY: config.paths.machineIdentity },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(parseDotenv(stdout)) : reject(new Error(`cage dump: ${stderr.trim() || `exit ${code}`}`))));
  });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) fail("usage: harness-telegram <config>");
  const parsed = parseConfig(readFileSync(configPath, "utf8"), process.getuid?.() === 0);
  if ("problems" in parsed) fail(`invalid configuration ${configPath}:\n  ${parsed.problems.join("\n  ")}`);
  const config = parsed.config;

  // The machine identity: only cage reads it, nothing inherits it.
  delete process.env.HARNESS_MACHINE_IDENTITY;
  {
    const identity = readFileSync(config.paths.machineIdentity, "utf8");
    if (!identity.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) fail(`${config.paths.machineIdentity} is not an OpenSSH private key`);
    chmodSync(config.paths.machineIdentity, 0o600);
  }
  const secrets = await machineSecrets(config).catch((error: unknown) => fail(String(error)));
  const token = secrets.get(config.telegram.tokenVariable) ?? fail(`machine secrets lack ${config.telegram.tokenVariable}`);
  const webhookSecret = secrets.get(config.telegram.webhookSecretVariable) ?? fail(`machine secrets lack ${config.telegram.webhookSecretVariable}`);

  // Listen first: a webhook that woke the machine is answered as soon as
  // possible; its updates wait here until the gateway is ready.
  let gateway: Gateway | undefined;
  let stopping = false;
  const early: Update[] = [];
  const server = await startWebhookServer({
    port: config.telegram.listenPort,
    path: new URL(config.telegram.publicUrl).pathname,
    secret: webhookSecret,
    onUpdate: (update) => {
      if (stopping) {
        log(`update ${update.update_id} dropped: stopping`);
      } else if (gateway === undefined) {
        early.push(update);
      } else {
        void gateway.onUpdate(update);
      }
    },
    log,
  });
  log(`listening on :${config.telegram.listenPort}`);

  const bot = new Bot(token);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  const me = await bot.api.getMe();
  if (me.has_topics_enabled !== true) fail(`@${me.username}: enable Threaded Mode (topics in private chats) in BotFather`);
  await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: "all_private_chats" } });
  // Always set: the secret may have changed, and getWebhookInfo does not show it.
  await bot.api.setWebhook(config.telegram.publicUrl, { secret_token: webhookSecret, allowed_updates: [...ALLOWED_UPDATES] });
  log(`@${me.username}: webhook ${config.telegram.publicUrl}`);

  for (const user of config.users) {
    const problems = await prepareUser(config, user);
    if (problems.length > 0) {
      log(`${user.name}: ${problems.join("; ")}`);
      await bot.api.sendMessage(user.telegramId, `Your account is not fully set up:\n${problems.join("\n")}`).catch((error: unknown) => log(`${user.name}: ${String(error)}`));
    } else {
      log(`${user.name}: ready`);
    }
  }

  const store = new StateStore(join(config.dataDir, "gateway", "state.json"));
  const pool = new SessionPool<PiProcess>(systemClock, {
    perUser: config.limits.sessionsPerUser,
    total: config.limits.sessionsTotal,
    idleMs: config.limits.idleMinutes * 60_000,
  });
  const ready: Gateway = new Gateway({
    config,
    store,
    pool,
    tg: bot.api,
    clock: systemClock,
    log,
    spawn: (spec, handlers) => new RpcProcess(spec, handlers),
    spec: (user, agent) => piSpec(config, user, agent.cwd, agent.sessionId),
    newDraftId: () => randomInt(1, 2 ** 31 - 1),
    startLogin: (user, args, callbacks) => new LoginRun(config, user, args, callbacks),
    download: async (fileId) => {
      const file = await bot.api.getFile(fileId);
      if (file.file_path === undefined) throw new Error("Telegram returned no file path");
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    activity: () => idle.activity(),
  });
  const idle = new IdleShutdown(systemClock, config.limits.idleShutdownMinutes * 60_000, () => ready.isQuiescent(), () => void stop("idle"));
  gateway = ready;
  for (const update of early.splice(0)) void ready.onUpdate(update);

  async function stop(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log(`stopping (${reason})`);
    idle.stop();
    server.close();
    await ready.shutdown();
    log("stopped");
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
