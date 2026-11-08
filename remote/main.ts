/**
 * harness-telegram: the Telegram gateway of a remote harness deployment.
 *
 *   harness-telegram <config.json|remote.yaml>
 *
 * Start: configuration → machine identity → machine secrets (bot token,
 * webhook secret; decrypted with cage into memory) → HTTP endpoint (updates
 * wait, the Mini App gets 503) → bot: commands, webhook → user accounts →
 * workspaces of users no longer configured dropped → ready.
 * Stop: SIGTERM/SIGINT (deploy) or idleness (nothing has happened for a while
 * and nothing runs): runs and dialogs are told, processes stop, the gateway
 * exits 0 and the machine sleeps until the next webhook wakes it.
 */

import { spawn } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { prepareUser, piSpec } from "./accounts.ts";
import { Assets } from "./app/assets.ts";
import { createApp } from "./app/server.ts";
import { parseConfig, type Config } from "./config.ts";
import type { PiProcess } from "./core/agent.ts";
import { systemClock } from "./core/clock.ts";
import { IdleShutdown } from "./core/idle.ts";
import { SessionPool } from "./core/pool.ts";
import { RpcProcess } from "./core/rpc.ts";
import { StateStore } from "./core/state.ts";
import { parseDotenv } from "./dotenv.ts";
import { createHelper } from "./helper.ts";
import { type AppHandler, startServer } from "./server.ts";
import { BOT_COMMANDS, Router } from "./telegram/router.ts";
import { Workbench } from "./workbench.ts";

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"] as const;
/** Deadline of one Bot API call. */
const BOT_API_TIMEOUT_SECONDS = 30;

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

function appFile(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
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
  const assets = new Assets({
    index: appFile("./app/index.html"),
    assets: { "app.js": appFile("./app/app.js"), "app.css": appFile("./app/app.css"), "alpine.js": appFile("../node_modules/alpinejs/dist/cdn.min.js") },
  });

  // Listen first: a webhook that woke the machine is answered as soon as
  // possible; its updates wait here until the gateway is ready.
  let router: Router | undefined;
  let app: AppHandler | undefined;
  let stopping = false;
  const early: Update[] = [];
  const server = await startServer({
    port: config.telegram.listenPort,
    webhookPath: new URL(config.telegram.publicUrl).pathname,
    webhookSecret,
    onUpdate: (update) => {
      if (stopping) {
        log(`update ${update.update_id} dropped: stopping`);
      } else if (router === undefined) {
        early.push(update);
      } else {
        void router.onUpdate(update);
      }
    },
    app: () => (stopping ? undefined : app),
    log,
  });
  log(`listening on :${config.telegram.listenPort}`);

  const bot = new Bot(token, { client: { timeoutSeconds: BOT_API_TIMEOUT_SECONDS } });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  const me = await bot.api.getMe();
  for (const type of ["all_private_chats", "all_group_chats"] as const) await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type } });
  // Always set: the secret may have changed, and getWebhookInfo does not show it.
  await bot.api.setWebhook(config.telegram.publicUrl, { secret_token: webhookSecret, allowed_updates: [...ALLOWED_UPDATES] });
  log(`@${me.username}: webhook ${config.telegram.publicUrl}, Mini App build ${assets.build}`);

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
  const helper = createHelper(config, systemClock);
  const workbench = new Workbench({
    config,
    store,
    pool,
    tg: bot.api,
    clock: systemClock,
    helper,
    botUsername: me.username,
    log,
    spawn: (spec, handlers) => new RpcProcess(spec, handlers),
    spec: (user, sessionId, cwd) => piSpec(config, user, cwd, sessionId),
  });
  await workbench.prune();
  const idle = new IdleShutdown(systemClock, config.limits.idleShutdownMinutes * 60_000, () => workbench.isQuiescent(), () => void stop("idle"));
  app = createApp({ workbench, helper, assets, botToken: token, clock: systemClock, log, activity: () => idle.activity() });
  router = new Router({
    workbench,
    log,
    download: async (fileId) => {
      const file = await bot.api.getFile(fileId);
      if (file.file_path === undefined) throw new Error("Telegram returned no file path");
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    activity: () => idle.activity(),
  });
  for (const update of early.splice(0)) void router.onUpdate(update);

  async function stop(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log(`stopping (${reason})`);
    idle.stop();
    server.close();
    await workbench.shutdown();
    log("stopped");
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
