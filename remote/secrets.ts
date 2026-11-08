/**
 * The user's own secrets: a cage store in ~/.cage with one env, `harness`,
 * whose variables every pi process of the user receives (accounts.ts
 * piSpec). Recipients are the user's server key and their configured personal
 * keys, so they can also manage the store from their own machines.
 *
 * Every cage call runs as the user; values go to cage through stdin only,
 * never through argv or the gateway's logs.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeOf, runAsUser, userEnv } from "./accounts.ts";
import type { Config, UserConfig } from "./config.ts";

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,47}$/;
const FILE = "harness.env";

function cageYaml(recipients: string[]): string {
  return [
    "kind: cage/v1",
    "dirs:",
    "  default: .cage/secrets",
    "recipients:",
    "  self:",
    ...recipients.map((key) => `    - ${JSON.stringify(key)}`),
    "envs:",
    "  harness:",
    `    files: [${FILE}]`,
    "    recipients: [self]",
    "",
  ].join("\n");
}

async function cage(config: Config, user: UserConfig, args: string[], input?: string): Promise<{ ok: true; stdout: string } | { ok: false; problem: string }> {
  const result = await runAsUser(config, user, config.paths.cage, args, input);
  if (result.code === 0) {
    return { ok: true, stdout: result.stdout };
  } else {
    const lines = result.stderr.trim().split("\n").filter((l) => l.trim() !== "");
    return { ok: false, problem: lines.slice(-3).join("\n") || `cage exited with ${result.code}` };
  }
}

/** Creates ~/.cage with the `harness` env unless a cage.yaml exists already. */
async function ensureStore(config: Config, user: UserConfig, serverKey: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (existsSync(join(homeOf(config, user), ".cage", "cage.yaml"))) {
    return { ok: true };
  } else {
    const init = await cage(config, user, ["init"]);
    if (!init.ok) return init;
    const write = await runAsUser(
      config,
      user,
      "sh",
      ["-c", `umask 077; cat > .cage/cage.yaml && mkdir -p .cage/secrets && touch .cage/secrets/${FILE}`],
      cageYaml([serverKey, ...user.publicKeys]),
    );
    return write.code === 0 ? { ok: true } : { ok: false, problem: write.stderr.trim() || `exit ${write.code}` };
  }
}

/** Names of the user's secrets (no values). */
export async function listSecrets(config: Config, user: UserConfig): Promise<{ names: string[] } | { problem: string }> {
  if (!existsSync(join(homeOf(config, user), ".cage", "cage.yaml"))) {
    return { names: [] };
  } else {
    const result = await cage(config, user, ["inspect", "-json", FILE]);
    if (!result.ok) return { problem: result.problem };
    const parsed = JSON.parse(result.stdout) as { files?: { vars?: { key: string }[] }[] };
    return { names: (parsed.files ?? []).flatMap((f) => (f.vars ?? []).map((v) => v.key)).sort() };
  }
}

export async function setSecret(config: Config, user: UserConfig, serverKey: string, name: string, value: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  const line = value.replace(/\r?\n$/, "");
  if (!SECRET_NAME.test(name)) {
    return { ok: false, problem: `invalid name ${name}: use A-Z, 0-9 and _` };
  } else if (line === "" || /[\r\n]/.test(line)) {
    return { ok: false, problem: "the value must be one non-empty line" };
  } else {
    const store = await ensureStore(config, user, serverKey);
    if (!store.ok) return store;
    const set = await cage(config, user, ["set", "-stdin", FILE, name], `${line}\n`);
    return set.ok ? { ok: true } : set;
  }
}

/**
 * Names of the variables the deployment sets for the user (its
 * `user-<name>.cage`, decrypted by `cage run` as the user). Only the names
 * leave the child process: it prints the keys of its environment, minus those
 * the gateway set itself.
 */
export async function deploymentSecretNames(config: Config, user: UserConfig): Promise<{ names: string[] } | { problem: string }> {
  const file = join(config.paths.envsDir, `user-${user.name}.cage`);
  if (!existsSync(file)) {
    return { names: [] };
  } else {
    const base = new Set(Object.keys(userEnv(config, user)));
    const printKeys = "process.stdout.write(JSON.stringify(Object.keys(process.env)))";
    const result = await runAsUser(config, user, config.paths.cage, ["run", "-raw", "-no-mask", file, "-", process.execPath, "-e", printKeys]);
    if (result.code !== 0) {
      return { problem: result.stderr.trim().split("\n").slice(-3).join("\n") || `cage exited with ${result.code}` };
    } else {
      return { names: (JSON.parse(result.stdout) as string[]).filter((name) => !base.has(name)).sort() };
    }
  }
}

/**
 * The variables that moved to the deployment's secrets (move-secrets.sh in
 * the deployment repository) leave the user's store, once the deployment
 * that sets them runs: a variable lives in one place at a time (cage refuses
 * the same name from two files). Resolves with the names removed.
 */
export async function dropMovedSecrets(config: Config, user: UserConfig): Promise<{ moved: string[] } | { problem: string }> {
  const own = await listSecrets(config, user);
  const deployment = await deploymentSecretNames(config, user);
  if ("problem" in own) {
    return own;
  } else if ("problem" in deployment) {
    return deployment;
  } else {
    const moved = own.names.filter((name) => deployment.names.includes(name));
    for (const name of moved) {
      const removed = await removeSecret(config, user, name);
      if (!removed.ok) return { problem: `${name}: ${removed.problem}` };
    }
    return { moved };
  }
}

export async function removeSecret(config: Config, user: UserConfig, name: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  const rm = await cage(config, user, ["rm", `${FILE}:${name}`]);
  return rm.ok ? { ok: true } : rm;
}
