// harness-test — the test harness's command line (plan 16.3, 16.5).
//
//   harness-test [unit|integration|all] [<name>] [--shots <step|all>]   run tests (all by default)
//   harness-test gallery [<filter>] [--compare <dir>]                    the TUI gallery
//   harness-test up <scenario file> [--until <step>]                     a stand in the background; prints its id
//   harness-test up --product [--web] [--kitty]                          the product: the bundle's harness (HARNESS_BUNDLE)
//                                                                        in a pseudo-terminal, the web app its hub serves
//   harness-test step|status|state|shot|logs|down <id> …                 control a stand
//   harness-test do <id> <client> action|key|type <value>                (a scenario's key: raw bytes; the product's: a key id, ctrl+n)
//   harness-test script <id> '<turns json>'                              the scripted model's next turns
//
// Reports: .test-reports/<run>/ (latest: .test-reports/latest).

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import { reportsRoot } from "../report/report.ts";
import { runGallery } from "../gallery/gallery.ts";
import { standsDir, type ControlAnswer, type ControlRequest, type StandRecord } from "./protocol.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function out(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function runTests(suite: string, name: string | undefined, shots: string | undefined): number {
  const run = new Date().toISOString().replace(/[:.]/g, "-");
  const globs = suite === "unit" ? ["packages/**/*.test.ts"] : suite === "integration" ? ["tests/**/*.test.ts"] : ["packages/**/*.test.ts", "tests/**/*.test.ts"];
  const files = spawnSync("node", ["-e", `const fs=require("fs");for(const g of process.argv.slice(1))for(const f of fs.globSync(g))console.log(f)`, ...globs], { cwd: ROOT, encoding: "utf8" })
    .stdout.split("\n")
    .filter((file) => file !== "" && !file.includes("/testdata/") && (name === undefined || file.includes(name)));
  if (files.length === 0) {
    process.stderr.write(`no tests match ${name ?? suite}\n`);
    return 1;
  } else {
    const env = { ...process.env, HARNESS_TEST_RUN: run, ...(shots !== undefined ? { HARNESS_TEST_SHOTS: shots } : {}) };
    const result = spawnSync("node", ["--test", "--test-concurrency=4", "--test-reporter=dot", ...files], { cwd: ROOT, env, stdio: "inherit" });
    const runDir = join(reportsRoot(), run);
    const reports = existsSync(runDir) ? readdirSync(runDir).map((scenario) => join(runDir, scenario, "report.md")).filter((path) => existsSync(path)) : [];
    for (const report of reports) {
      process.stderr.write(`failed: ${report}\n`);
    }
    return result.status ?? 1;
  }
}

function control(id: string, request: ControlRequest): Promise<unknown> {
  const recordPath = join(standsDir(), `${id}.json`);
  if (!existsSync(recordPath)) {
    throw new Error(`no stand ${id} (harness-test up starts one)`);
  } else {
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as StandRecord;
    return new Promise((resolve, reject) => {
      const socket = createConnection(record.socket);
      const decoder = new LineDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          const decoded = decodeRecord(line);
          const reply = decoded.ok ? (decoded.record as ControlAnswer) : { ok: false as const, error: decoded.error };
          if (reply.ok) {
            resolve(reply.data);
          } else {
            reject(new Error(reply.error));
          }
        }
      });
      socket.on("error", reject);
      socket.write(encodeRecord(request));
    });
  }
}

async function up(target: string[], until: string | undefined): Promise<void> {
  const id = Math.random().toString(36).slice(2, 8);
  const host = join(import.meta.dirname, "host.ts");
  mkdirSync(standsDir(), { recursive: true });
  // the host outlives this command: its output goes to a file next to its socket
  const logPath = join(standsDir(), `${id}.log`);
  const log = openSync(logPath, "a");
  const child = spawn("node", [host, id, ...target, ...(until !== undefined ? [until] : [])], { cwd: ROOT, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  const recordPath = join(standsDir(), `${id}.json`);
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (existsSync(recordPath)) {
        clearInterval(timer);
        resolve();
      } else {
        // not ready yet
      }
    }, 100);
    child.on("exit", (code) => {
      clearInterval(timer);
      reject(new Error(`the stand host exited (${code}):\n${readFileSync(logPath, "utf8")}`));
    });
  });
  child.removeAllListeners("exit");
  child.unref();
  out(id);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { shots: { type: "string" }, until: { type: "string" }, compare: { type: "string" }, lines: { type: "string" }, product: { type: "boolean" }, web: { type: "boolean" }, kitty: { type: "boolean" } },
  });
  const [id, ...args] = positionals;
  switch (command ?? "all") {
    case "all":
    case "unit":
    case "integration":
      process.exitCode = runTests(command ?? "all", positionals[0], values.shots);
      break;
    case "gallery":
      out(await runGallery({ filter: positionals[0], compare: values.compare }));
      break;
    case "up":
      if (values.product === true) {
        await up(["--product", ...(values.web === true ? ["--web"] : []), ...(values.kitty === true ? ["--kitty"] : [])], undefined);
      } else {
        await up([id ?? ""], values.until);
      }
      break;
    case "script":
      out(await control(id ?? "", { cmd: "script", turns: args[0] ?? "[]" }));
      break;
    case "status":
    case "step":
    case "shot":
    case "down":
      out(await control(id ?? "", { cmd: command } as ControlRequest));
      break;
    case "until":
      out(await control(id ?? "", { cmd: "until", step: values.until }));
      break;
    case "state":
      out(await control(id ?? "", { cmd: "state", client: args[0] ?? "" }));
      break;
    case "logs":
      out(await control(id ?? "", { cmd: "logs", lines: values.lines !== undefined ? Number(values.lines) : undefined }));
      break;
    case "do": {
      const [client, kind, ...value] = args;
      if (client === undefined || (kind !== "action" && kind !== "key" && kind !== "type")) {
        throw new Error("usage: harness-test do <id> <client> action|key|type <value>");
      } else {
        const reply = (await control(id ?? "", { cmd: "do", client, kind, value: value.join(" ") })) as { screen: string };
        out(reply.screen);
      }
      break;
    }
    default:
      throw new Error(`unknown command ${command}; see the header of packages/testkit/src/control/cli.ts`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`harness-test: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
