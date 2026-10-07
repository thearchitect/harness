#!/usr/bin/env node
/**
 * locked-exec - run an npm package binary through `bun x` or `npx` without
 * install races.
 *
 *   locked-exec.mjs [options] <pkg>[@spec] [args...]
 *   locked-exec.mjs [options] -p|--package <spec> <bin> [args...]
 *
 * Options (before the package):
 *   --runner bun|npx|auto   package runner (default: $LOCKED_EXEC_RUNNER or auto:
 *                           bun when available, else npx)
 *   --install-only          install the package (serialized), do not run it
 *   --is-installed          exit 0 if the resolved package is already installed
 *
 * Problem: several processes starting `bun x pkg@latest` (or `npx`) at once,
 * e.g. MCP servers of parallel pi sessions, install into the same cache
 * directory concurrently and corrupt each other (ENOENT while copying files).
 *
 * Flow:
 *   1. Resolve the spec. A dist-tag (`latest`, `next`, or none) is resolved to
 *      an exact version through the npm registry ($npm_config_registry,
 *      default registry.npmjs.org). Exact versions, tarball/git URLs and paths
 *      are used as given ("pinned").
 *   2. Under a lock keyed by the pinned spec, install it without running it.
 *   3. Release the lock and run it from the cache. Runs of a pinned, installed
 *      spec do not write to the cache, so they can run in parallel.
 *   Fallback (version ranges, registry unreachable, install-only unsupported):
 *   start the package under the lock and release it at the first stdout
 *   output, at exit, or after LOCKED_EXEC_START_TIMEOUT_MS (default 120 s).
 *
 * Compatibility matrix (script runs under node >= 22 or bun):
 *
 *   |        | linux                         | macos                         |
 *   |--------|-------------------------------|-------------------------------|
 *   | lock   | abstract unix socket (no file)| unix socket file in tmpdir    |
 *   | bun x  | install: `bun x -p spec NOOP` | same                          |
 *   | npx    | install: `npx -p spec -- node -e 0`, run: `npx --prefer-offline` | same |
 *
 * Locks: a listening unix socket is the mutex. On linux it lives in the
 * abstract namespace, so the kernel frees it when the holder dies and nothing
 * is left on disk. On macos (no abstract namespace) it is a socket file in
 * os.tmpdir(); a leftover file from a crashed holder is detected by
 * ECONNREFUSED and removed. (After such a crash, two waiters detecting the
 * stale file at the same instant can both proceed once; acceptable for this
 * crash-only window.) LOCKED_EXEC_LOCK=abstract|file forces a kind (testing).
 *
 * External behavior relied on (re-check when bun changes):
 *   `bun x -p <spec> <missing-bin>` installs the package and then fails with
 *   "does not provide a binary named ..."; bun x has no install-only flag.
 *   `bun x --no-install -p <spec> <missing-bin>` reports the same message when
 *   the package is cached and "Could not find an existing ..." when it is not.
 *   If these messages change, install-only fails and the fallback is used.
 *   `--is-installed` with bun checks bun's bunx cache layout
 *   (<tmpdir>/bunx-<uid>-<name>@<version>/node_modules/<name>); a miss only
 *   costs an extra (serialized) install-only run.
 *
 * Only stderr is used for diagnostics: stdout belongs to the package (MCP
 * stdio servers).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

const NOOP_BIN = "__locked_exec_noop__";
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = Number(process.env.LOCKED_EXEC_START_TIMEOUT_MS) || 120 * 1000;
const REGISTRY_TIMEOUT_MS = 5000;

const log = (message) => process.stderr.write(`[locked-exec] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------------------
 * Arguments
 * ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { runner: process.env.LOCKED_EXEC_RUNNER || "auto", mode: "run" };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest[0];
    if (arg === "--runner") {
      rest.shift();
      opts.runner = rest.shift();
    } else if (arg.startsWith("--runner=")) {
      opts.runner = rest.shift().slice("--runner=".length);
    } else if (arg === "--install-only") {
      rest.shift();
      opts.mode = "install";
    } else if (arg === "--is-installed") {
      rest.shift();
      opts.mode = "installed";
    } else if (arg === "-p" || arg === "--package") {
      rest.shift();
      opts.packageSpec = rest.shift();
    } else if (arg.startsWith("--package=")) {
      opts.packageSpec = rest.shift().slice("--package=".length);
    } else if (arg === "--") {
      rest.shift();
      break;
    } else {
      break;
    }
  }
  if (opts.packageSpec) {
    if (opts.mode === "run") opts.bin = rest.shift();
  } else {
    opts.packageSpec = rest.shift();
  }
  opts.args = rest;
  if (!opts.packageSpec || (opts.mode === "run" && opts.bin === undefined && argv.some((a) => a === "-p" || a === "--package" || a.startsWith("--package=")))) {
    log("usage: locked-exec.mjs [--runner bun|npx|auto] [--install-only|--is-installed] <pkg>[@spec] [args...] | -p <spec> <bin> [args...]");
    process.exit(2);
  }
  if (!["auto", "bun", "npx"].includes(opts.runner)) {
    log(`unknown runner "${opts.runner}"`);
    process.exit(2);
  }
  return opts;
}

/** Splits "name@spec" (scoped names included). A bare URL/path has no name. */
function splitSpec(spec) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith(".") || spec.startsWith("/")) {
    return { name: undefined, version: spec };
  }
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at < 0 ? { name: spec, version: "" } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** "tag" | "pinned" | "range" */
function classify({ name, version }) {
  if (!name) return "pinned";
  if (version === "") return "tag";
  if (EXACT_VERSION.test(version) || /[:/]/.test(version)) return "pinned";
  if (DIST_TAG.test(version) && version !== "x" && version !== "X") return "tag";
  return "range";
}

async function resolveTag(name, tag) {
  const registry = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  const url = `${registry}/${name.replace("/", "%2f")}/${encodeURIComponent(tag || "latest")}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { version } = await response.json();
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) throw new Error("no version in response");
    return version;
  } catch (error) {
    log(`cannot resolve ${name}@${tag || "latest"} (${error.message}); using fallback`);
    return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Runner
 * ------------------------------------------------------------------------ */

function onPath(command) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function pickRunner(requested) {
  if (requested !== "auto") return requested;
  return process.versions.bun || onPath("bun") ? "bun" : "npx";
}

function runnerCommand(runner) {
  if (runner === "bun") return process.versions.bun ? process.execPath : "bun";
  return "npx";
}

/** Arguments that run the package (pinned: from cache). */
function runArgs(runner, spec, bin, args, pinned) {
  if (runner === "bun") return bin === undefined ? ["x", spec, ...args] : ["x", "-p", spec, bin, ...args];
  // --prefer-offline, not --offline: npm does not serve remote tarball URLs from cache offline.
  const offline = pinned ? ["--prefer-offline"] : [];
  return bin === undefined
    ? ["--yes", ...offline, "--", spec, ...args]
    : ["--yes", ...offline, "-p", spec, "--", bin, ...args];
}

/**
 * Runs a helper command, capturing stdout and stderr; resolves exit code and
 * the captured output. The output is echoed to stderr at the end (stdout
 * belongs to the package), minus lines matching `hide` (expected noise such
 * as the NOOP binary error and its hint).
 */
function runQuiet(command, args, hide) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const collect = (chunk) => {
      stderr += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code, output) => {
      const shown = output
        .split("\n")
        .filter((line) => !(hide && hide.test(line)))
        .join("\n")
        .trim();
      if (shown) process.stderr.write(`${shown}\n`);
      resolve({ code, stderr: output });
    };
    child.on("error", (error) => finish(-1, String(error.message)));
    child.on("close", (code) => finish(code ?? -1, stderr));
  });
}

const NOOP_NOISE = new RegExp(`${NOOP_BIN}|try running without --package`);

async function installOnly(runner, spec) {
  if (runner === "bun") {
    const { code, stderr } = await runQuiet(runnerCommand(runner), ["x", "-p", spec, NOOP_BIN], NOOP_NOISE);
    return code === 0 || stderr.includes(`binary named ${NOOP_BIN}`);
  }
  const { code } = await runQuiet("npx", ["--yes", "-p", spec, "--", "node", "-e", "0"]);
  return code === 0;
}

async function isInstalled(runner, spec) {
  if (runner === "bun") {
    // bun x has no side-effect-free check; look at its cache layout.
    const { name, version } = splitSpec(spec);
    if (!name || !EXACT_VERSION.test(version)) return false;
    const dir = join(tmpdir(), `bunx-${userInfo().uid}-${name}@${version}`, "node_modules", name, "package.json");
    return existsSync(dir);
  }
  const { code } = await runQuiet("npx", ["--yes", "--offline", "-p", spec, "--", "node", "-e", "0"]);
  return code === 0;
}

/* ---------------------------------------------------------------------------
 * Lock
 * ------------------------------------------------------------------------ */

/** Unix socket paths are limited (104 bytes on macos, 108 on linux) and silently truncated. */
const MAX_SOCKET_PATH = 100;

function lockPath(key) {
  const hash = createHash("sha1").update(key).digest("hex");
  const kind = process.env.LOCKED_EXEC_LOCK || (process.platform === "linux" ? "abstract" : "file");
  if (kind === "abstract") return { kind, path: `\0locked-exec:${hash}` };
  const name = `locked-exec-${hash.slice(0, 16)}.sock`;
  const preferred = join(tmpdir(), name);
  return { kind, path: Buffer.byteLength(preferred) <= MAX_SOCKET_PATH ? preferred : join("/tmp", name) };
}

function tryListen(path) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error)));
    server.listen(path, () => resolve(server));
  });
}

function isStale(path) {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT"));
  });
}

/** Acquires the lock for `key`; resolves a release function. */
async function acquireLock(key) {
  const { kind, path } = lockPath(key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 100;
  let announced = false;
  for (;;) {
    const server = await tryListen(path);
    if (server) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        server.close();
      };
    }
    if (kind === "file" && (await isStale(path))) {
      try {
        unlinkSync(path);
        continue;
      } catch {
        // someone else removed it; wait like for a live holder
      }
    }
    if (!announced) {
      log(`waiting for another install of ${key}`);
      announced = true;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the lock on ${key}`);
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 300);
  }
}

/* ---------------------------------------------------------------------------
 * Execution
 * ------------------------------------------------------------------------ */

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Runs the package with inherited stdin/stderr. With `release`, stdout is
 * piped through so the lock can be released at the first output.
 */
function execPackage(command, args, release) {
  const child = spawn(command, args, { stdio: ["inherit", release ? "pipe" : "inherit", "inherit"] });
  if (release) {
    const timer = setTimeout(release, START_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.once("data", () => {
      clearTimeout(timer);
      release();
    });
    child.stdout.pipe(process.stdout);
    child.on("exit", () => {
      clearTimeout(timer);
      release();
    });
  }
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    log(`cannot start ${command}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      for (const forwarded of FORWARDED_SIGNALS) process.removeAllListeners(forwarded);
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runner = pickRunner(opts.runner);
  const parts = splitSpec(opts.packageSpec);
  let kind = classify(parts);
  let spec = opts.packageSpec;

  if (kind === "tag") {
    const version = await resolveTag(parts.name, parts.version);
    if (version) {
      spec = `${parts.name}@${version}`;
      kind = "pinned";
    }
  }

  if (opts.mode === "installed") {
    process.exit(kind === "pinned" && (await isInstalled(runner, spec)) ? 0 : 1);
  }

  const lockKey = `${runner}:${spec}`;
  if (kind === "pinned") {
    const release = await acquireLock(lockKey);
    let installed;
    try {
      installed = await installOnly(runner, spec);
    } finally {
      if (installed || opts.mode === "install") release();
    }
    if (opts.mode === "install") process.exit(installed ? 0 : 1);
    if (installed) {
      execPackage(runnerCommand(runner), runArgs(runner, spec, opts.bin, opts.args, true));
      return;
    }
    log(`install-only failed for ${spec}; starting under the lock`);
    execPackage(runnerCommand(runner), runArgs(runner, spec, opts.bin, opts.args, false), release);
    return;
  }

  if (opts.mode === "install") {
    log(`cannot install "${spec}" without running it (not a pinned spec)`);
    process.exit(1);
  }
  const release = await acquireLock(lockKey);
  execPackage(runnerCommand(runner), runArgs(runner, spec, opts.bin, opts.args, false), release);
}

main().catch((error) => {
  log(error.stack || error.message);
  process.exit(1);
});
