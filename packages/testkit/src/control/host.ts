// The stand host: `harness-test up` runs this in the background. It brings a scenario up (its stand
// and clients), runs it to the requested step, and serves the control channel until `down`: steps,
// actions on clients, their state, screens, logs.
//
//   node host.ts <id> <scenario file> [<until step>]

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionId } from "#client/keymap.ts";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import { TuiDriver } from "../drivers/tui.ts";
import { modelState } from "../report/report.ts";
import { ScenarioRun, type Scenario } from "../scenario/scenario.ts";
import { standsDir, type ControlAnswer, type ControlRequest, type StandRecord } from "./protocol.ts";

async function main(): Promise<void> {
  const [id, file, until] = process.argv.slice(2);
  if (id === undefined || file === undefined) {
    throw new Error("usage: host.ts <id> <scenario file> [<until step>]");
  } else {
    process.env.HARNESS_TEST_HOST = "1";
    const module = (await import(pathToFileURL(resolve(file)).href)) as { scenario?: Scenario };
    if (module.scenario === undefined) {
      throw new Error(`${file} exports no scenario (export const scenario = defineScenario(…))`);
    } else {
      const run = await ScenarioRun.up(module.scenario);
      if (until !== undefined) {
        await run.until(until);
      } else {
        // stays before the first step
      }
      await serve(id, file, run);
    }
  }
}

function client(run: ScenarioRun, name: string) {
  const found = run.context.clients[name];
  if (found === undefined) {
    throw new Error(`no client ${name}: ${Object.keys(run.context.clients).join(", ")}`);
  } else {
    return found;
  }
}

async function answer(run: ScenarioRun, request: ControlRequest, stop: () => void): Promise<unknown> {
  switch (request.cmd) {
    case "status":
      return { scenario: run.scenario.name, next: run.scenario.steps[run.next]?.name ?? null, steps: run.scenario.steps.map((step) => step.name), report: run.report.dir };
    case "step":
      return { ran: (await run.step()).name, next: run.scenario.steps[run.next]?.name ?? null };
    case "until":
      await run.until(request.step);
      return { next: run.scenario.steps[run.next]?.name ?? null };
    case "do": {
      const target = client(run, request.client);
      if (!(target instanceof TuiDriver)) {
        throw new Error(`${request.client} is not a UI client`);
      } else if (request.kind === "action") {
        await target.act(request.value as ActionId);
      } else if (request.kind === "type") {
        await target.type(request.value);
      } else {
        await target.press(JSON.parse(`"${request.value}"`) as string);
      }
      return { screen: target.text() };
    }
    case "state":
      return modelState(client(run, request.client));
    case "shot":
      return { files: await run.report.shoot(`shot-${Date.now()}`) };
    case "logs": {
      const dir = join(run.context.stand.dataDir, "log", "agents");
      const lines = request.lines ?? 40;
      return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8").split("\n").slice(-lines).join("\n")]));
    }
    case "down":
      stop();
      return {};
    default:
      throw new Error(`unknown command: ${JSON.stringify(request satisfies never)}`);
  }
}

async function serve(id: string, file: string, run: ScenarioRun): Promise<void> {
  const dir = standsDir();
  mkdirSync(dir, { recursive: true });
  const socket = join(dir, `${id}.sock`);
  const recordPath = join(dir, `${id}.json`);
  const stop = (): void => {
    server.close();
    rmSync(socket, { force: true });
    rmSync(recordPath, { force: true });
    rmSync(join(dir, `${id}.log`), { force: true });
    void run.down().then(() => process.exit(0));
  };
  const server = createServer((connection) => {
    const decoder = new LineDecoder();
    connection.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const decoded = decodeRecord(line);
        const request = decoded.ok ? (decoded.record as ControlRequest) : undefined;
        void (async (): Promise<ControlAnswer> => {
          try {
            if (request === undefined) {
              throw new Error("malformed request");
            } else {
              return { ok: true, data: await answer(run, request, stop) };
            }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })().then((reply) => connection.end(encodeRecord(reply)));
      }
    });
  });
  server.listen(socket);
  const record: StandRecord = { id, pid: process.pid, socket, scenario: run.scenario.name, file, report: run.report.dir };
  writeFileSync(recordPath, JSON.stringify(record));
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`harness-test host: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
