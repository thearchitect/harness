// The product by hand: `harness-test up --product [--web] [--kitty]` brings up what the golden path
// tests (drivers/product.ts) — a stand's home, the bundle's real `harness` in a pseudo-terminal,
// optionally the web app its hub serves — and answers the same control channel as a scenario's
// stand: `do <id> tui|web action|key|type`, `script`, `state`, `shot`, `logs`, `down`. Every check
// done by hand runs through the instrumentation the tests use; nothing is driven from outside it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalActionId } from "#client/input/actions.ts";
import { GLOBAL_ACTIONS } from "#client/input/actions.ts";
import { formatLogRecord, readLogs } from "#hub/log-files.ts";
import { ProductTui } from "../drivers/product.ts";
import type { WebDriver } from "../drivers/web.ts";
import { createStandHome, type StandHome } from "../stand/stand.ts";
import type { ScriptedTurn } from "../stand/scenario-model.ts";
import type { ControlRequest } from "./protocol.ts";

export type ProductRun = { home: StandHome; tui: ProductTui; web: WebDriver | undefined; shots: string };

export async function productUp(flags: string[]): Promise<ProductRun> {
  const bundle = process.env.HARNESS_BUNDLE;
  if (bundle === undefined || bundle === "") {
    throw new Error("the product needs a bundle: HARNESS_BUNDLE=$(nix build --print-out-paths)");
  } else {
    const home = createStandHome();
    const tui = await ProductTui.start({ bundle, home, kitty: flags.includes("--kitty") });
    const web = flags.includes("--web") ? await tui.web() : undefined;
    const shots = join(home.root, "shots");
    mkdirSync(shots, { recursive: true });
    return { home, tui, web, shots };
  }
}

export async function productAnswer(run: ProductRun, request: ControlRequest, stop: () => void): Promise<unknown> {
  switch (request.cmd) {
    case "status":
      return { product: true, home: run.home.root, project: run.home.project, web: run.web !== undefined, shots: run.shots };
    case "do": {
      if (request.client === "tui") {
        if (request.kind === "action") {
          await run.tui.act(globalAction(request.value));
        } else if (request.kind === "type") {
          await run.tui.type(request.value);
        } else {
          await run.tui.key(request.value);
        }
        return { screen: run.tui.text() };
      } else if (request.client === "web" && run.web !== undefined) {
        if (request.kind === "action") {
          // a browser tab keeps Ctrl+letter: its Alt alike
          await run.web.key(`alt+${GLOBAL_ACTIONS[globalAction(request.value)].key}`);
        } else if (request.kind === "type") {
          await run.web.keys(request.value);
        } else {
          await run.web.key(request.value);
        }
        return { screen: await run.web.text() };
      } else {
        throw new Error(`no client ${request.client}: tui${run.web !== undefined ? ", web" : ""}`);
      }
    }
    case "script":
      run.home.script(JSON.parse(request.turns) as ScriptedTurn[]);
      return {};
    case "state":
      return { tui: run.tui.text(), ...(run.web !== undefined ? { web: await run.web.text() } : {}) };
    case "shot": {
      const name = `shot-${Date.now()}`;
      writeFileSync(join(run.shots, `${name}.tui.txt`), run.tui.text());
      writeFileSync(join(run.shots, `${name}.tui.ansi`), run.tui.ansi);
      const files = [join(run.shots, `${name}.tui.txt`), ...(run.web !== undefined ? await run.web.capture(run.shots, `${name}.web`) : [])];
      return { files };
    }
    case "logs":
      return readLogs(run.home.layout.log, { last: request.lines ?? 60 }).map(formatLogRecord).join("\n");
    case "step":
    case "until":
      throw new Error("the product has no scenario steps: act on its clients with `do`");
    case "down":
      stop();
      return {};
    default:
      throw new Error(`unknown command: ${JSON.stringify(request satisfies never)}`);
  }
}

export async function productDown(run: ProductRun): Promise<void> {
  run.web?.stop();
  await Promise.race([run.tui.quit(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  run.tui.kill();
  run.home.remove();
}

function globalAction(value: string): GlobalActionId {
  if (value in GLOBAL_ACTIONS) {
    return value as GlobalActionId;
  } else {
    throw new Error(`no action ${value}: ${Object.keys(GLOBAL_ACTIONS).join(", ")}`);
  }
}
