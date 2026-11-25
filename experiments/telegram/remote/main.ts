/**
 * harness-telegram: the Telegram gateway of a remote harness deployment.
 *
 *   harness-telegram <config.json|remote.yaml>
 *
 * Start: configuration → journal (telemetry.ts) → machine identity → machine
 * secrets (bot token, webhook secret; decrypted with cage into memory) → HTTP
 * endpoint (updates wait, the Mini App gets 503) → bot: commands, webhook →
 * admins' alerts, a report on a previous run that failed → user accounts →
 * workspaces of users no longer configured dropped → ready.
 * Stop: SIGTERM/SIGINT (deploy) or idleness (nothing has happened for a while
 * and nothing runs): runs and dialogs are told, processes stop, the gateway
 * exits 0 and the machine sleeps until the next webhook wakes it. A crash
 * (uncaught error) is journaled, sent to the admins, and exits 1.
 */

import { spawn } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
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
import { dropMovedSecrets } from "./secrets.ts";
import { type AppHandler, startServer } from "./server.ts";
import { ADMIN_COMMANDS, BOT_COMMANDS, Router } from "./telegram/router.ts";
import { Alerts, type Fields, Journal } from "./telemetry.ts";
import { Workbench } from "./workbench.ts";

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"] as const;
/** Deadline of one Bot API call. */
const BOT_API_TIMEOUT_SECONDS = 30;
const RESOURCES_EVERY_MS = 60_000;

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function machineSecrets(config: Config): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.paths.cage, ["dump", "-o", "/dev/stdout", join(config.paths.envsDir, "machine.cage")], {
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", CAGE_SSH_IDENTITY: config.paths.machineIdentity },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrText = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderrText += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(parseDotenv(stdout)) : reject(new Error(`cage dump: ${stderrText.trim() || `exit ${code}`}`))));
  });
}

function appFile(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

/** Memory and load of the machine, and how many pi processes run. */
function resources(pool: SessionPool<PiProcess> | undefined): Fields {
  return {
    memFreeMb: Math.round(freemem() / 1048576),
    memTotalMb: Math.round(totalmem() / 1048576),
    load1: Number((loadavg()[0] ?? 0).toFixed(2)),
    ...(pool !== undefined ? { piProcesses: pool.size } : {}),
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    stderr("usage: harness-telegram <config>");
    process.exit(2);
  }
  const parsed = parseConfig(readFileSync(configPath, "utf8"), process.getuid?.() === 0);
  if ("problems" in parsed) {
    stderr(`fatal: invalid configuration ${configPath}:\n  ${parsed.problems.join("\n  ")}`);
    process.exit(1);
  }
  const config = parsed.config;

  // The journal first: everything after this, a failed start included, is on the volume.
  const journal = new Journal({ dir: join(config.dataDir, "gateway", "log"), clock: systemClock, retentionDays: config.telemetry.retentionDays, stderr });
  const previous = journal.previousRun();
  const alerts = new Alerts(systemClock);
  journal.onError((event) => alerts.alert(event));
  let stopping = false;
  let workbench: Workbench | undefined;
  const crash = (kind: string, error: unknown): void => {
    journal.error(kind, { message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    // the alert is queued or on its way; give it a moment, then exit
    setTimeout(() => process.exit(1), 2_000).unref();
  };
  onFatal = (error) => crash("gateway.fatal", error);
  process.on("uncaughtException", (error) => crash("gateway.crash", error));
  process.on("unhandledRejection", (error) => crash("gateway.crash", error));
  journal.info("gateway.start", {
    image: process.env.FLY_IMAGE_REF,
    machine: process.env.FLY_MACHINE_ID,
    region: process.env.FLY_REGION,
    harness: process.env.HARNESS_REVISION,
    ...resources(undefined),
  });

  const fail = (message: string): never => {
    throw new Error(message);
  };

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
  journal.addSecret(token);
  journal.addSecret(webhookSecret);
  const assets = new Assets({
    index: appFile("./app/index.html"),
    assets: { "app.js": appFile("./app/app.js"), "app.css": appFile("./app/app.css"), "alpine.js": appFile("../node_modules/alpinejs/dist/cdn.min.js") },
  });

  // Listen first: a webhook that woke the machine is answered as soon as
  // possible; its updates wait here until the gateway is ready.
  let router: Router | undefined;
  let app: AppHandler | undefined;
  const early: Update[] = [];
  const server = await startServer({
    port: config.telegram.listenPort,
    webhookPath: new URL(config.telegram.publicUrl).pathname,
    webhookSecret,
    onUpdate: (update) => {
      if (stopping) {
        journal.warn("update.dropped", { update: update.update_id, message: "stopping" });
      } else if (router === undefined) {
        early.push(update);
      } else {
        void router.onUpdate(update);
      }
    },
    app: () => (stopping ? undefined : app),
    t: journal,
  });

  const bot = new Bot(token, { client: { timeoutSeconds: BOT_API_TIMEOUT_SECONDS } });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  const me = await bot.api.getMe();
  for (const type of ["all_private_chats", "all_group_chats"] as const) await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type } });
  const admins = config.users.filter((user) => user.admin);
  for (const admin of admins) await bot.api.setMyCommands(ADMIN_COMMANDS, { scope: { type: "chat", chat_id: admin.telegramId } });
  // Always set: the secret may have changed, and getWebhookInfo does not show it.
  await bot.api.setWebhook(config.telegram.publicUrl, { secret_token: webhookSecret, allowed_updates: [...ALLOWED_UPDATES] });
  journal.info("gateway.webhook", { bot: me.username, url: config.telegram.publicUrl, app: assets.build });

  alerts.ready(async (text) => {
    for (const admin of admins) {
      await bot.api.sendMessage(admin.telegramId, text, { link_preview_options: { is_disabled: true } }).catch((error: unknown) => {
        stderr(`alert to ${admin.name} failed: ${String(error)}`); // not journaled: an error here would alert again
      });
    }
  });
  if (previous !== undefined && !previous.clean) {
    const last = previous.lastError;
    journal.error("gateway.previous_failed", { message: last !== undefined ? `${last.kind}: ${String(last.message ?? "")}`.slice(0, 1500) : "it ended without stopping (killed or out of memory?)", at: last?.ts });
  } else {
    // the previous run stopped cleanly, or there was none
  }

  for (const user of config.users) {
    const problems = await prepareUser(config, user);
    const dropped = problems.length === 0 ? await dropMovedSecrets(config, user) : { moved: [] };
    const moved = "moved" in dropped ? dropped.moved : [];
    if ("problem" in dropped) problems.push(`secrets: ${dropped.problem}`);
    if (problems.length > 0) {
      journal.error("account.prepare", { user: user.name, message: problems.join("; ") });
      await bot.api.sendMessage(user.telegramId, `Your account is not fully set up:\n${problems.join("\n")}`).catch((error: unknown) => {
        journal.warn("tg.call", { user: user.name, method: "sendMessage", message: String(error) });
      });
    } else if (moved.length > 0) {
      journal.info("account.secrets_moved", { user: user.name, names: moved });
      await bot.api.sendMessage(user.telegramId, `Moved to the deployment's secrets: ${moved.join(", ")}.`).catch((error: unknown) => {
        journal.warn("tg.call", { user: user.name, method: "sendMessage", message: String(error) });
      });
    } else {
      journal.info("account.ready", { user: user.name });
    }
  }

  const store = new StateStore(join(config.dataDir, "gateway", "state.json"));
  const pool = new SessionPool<PiProcess>(systemClock, {
    perUser: config.limits.sessionsPerUser,
    total: config.limits.sessionsTotal,
    idleMs: config.limits.idleMinutes * 60_000,
  });
  const helper = createHelper(config, systemClock);
  workbench = new Workbench({
    config,
    store,
    pool,
    tg: bot.api,
    clock: systemClock,
    helper,
    botUsername: me.username,
    t: journal,
    resources: () => resources(pool),
    spawn: (spec, handlers) => new RpcProcess(spec, handlers),
    spec: (user, sessionId, cwd) => piSpec(config, user, cwd, sessionId),
  });
  await workbench.prune();
  const wb = workbench;
  const idle = new IdleShutdown(systemClock, config.limits.idleShutdownMinutes * 60_000, () => wb.isQuiescent(), () => void stop("idle"));
  app = createApp({ workbench: wb, helper, assets, botToken: token, clock: systemClock, t: journal, activity: () => idle.activity() });
  router = new Router({
    workbench: wb,
    clock: systemClock,
    t: journal,
    download: async (fileId) => {
      const file = await bot.api.getFile(fileId);
      if (file.file_path === undefined) throw new Error("Telegram returned no file path");
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    journal: (from, to) => journal.read(from, to),
    activity: () => idle.activity(),
  });
  const sampler = setInterval(() => journal.info("gateway.resources", resources(pool)), RESOURCES_EVERY_MS);
  journal.info("gateway.ready", { users: config.users.length, early: early.length });
  for (const update of early.splice(0)) void router.onUpdate(update);

  async function stop(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    journal.info("gateway.stopping", { reason });
    clearInterval(sampler);
    idle.stop();
    server.close();
    await wb.shutdown();
    journal.info("gateway.stop", { reason });
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

/** How a failed start ends once the journal exists: journaled, sent to the admins when they can be reached. */
let onFatal: ((error: unknown) => void) | undefined;

main().catch((error: unknown) => {
  if (onFatal !== undefined) {
    onFatal(error);
  } else {
    stderr(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  }
});
