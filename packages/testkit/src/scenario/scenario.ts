// Scenarios: a stand, its clients and named steps. The same definition runs under hub's test
// runner (`runScenario`, one test per step) and under the stand host of `harness-test up`, which
// stops between steps for an operator or an agent to look and act. A step boundary is where
// captures and reports are taken; a failure writes the report (report.ts) before it fails.

import { after, before, describe, test } from "node:test";
import { HubConnection } from "#client/connection.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { TuiDriver } from "../drivers/tui.ts";
import { RawDriver } from "../drivers/raw.ts";
import { WebDriver } from "../drivers/web.ts";
import { createStand, type Stand, type StandOptions } from "../stand/stand.ts";
import { Report } from "../report/report.ts";

export type ClientKind = "tui" | "raw" | "web";

/** A step that runs longer has hung (steps wait for events, never for time). */
const STEP_TIMEOUT_MS = 45_000;

export type ClientSpec = { kind: ClientKind; columns?: number; rows?: number };

export type Driver = TuiDriver | RawDriver | WebDriver;

export type Clients = Record<string, Driver>;

export type ScenarioContext<C extends Record<string, ClientSpec>> = {
  stand: Stand;
  clients: { [K in keyof C]: C[K]["kind"] extends "tui" ? TuiDriver : C[K]["kind"] extends "web" ? WebDriver : RawDriver };
  /** The step's scratch space for values later steps need. */
  memo: Record<string, unknown>;
};

export type Step<C extends Record<string, ClientSpec>> = { name: string; run(context: ScenarioContext<C>): Promise<void> };

export type Scenario<C extends Record<string, ClientSpec> = Record<string, ClientSpec>> = {
  name: string;
  stand?: StandOptions;
  clients: C;
  steps: Step<C>[];
};

export function defineScenario<C extends Record<string, ClientSpec>>(scenario: Scenario<C>): Scenario<C> {
  return scenario;
}

/** A scenario brought up: its stand and clients, run step by step. */
export class ScenarioRun<C extends Record<string, ClientSpec> = Record<string, ClientSpec>> {
  readonly scenario: Scenario<C>;
  readonly context: ScenarioContext<C>;
  readonly report: Report;
  next = 0;

  private constructor(scenario: Scenario<C>, context: ScenarioContext<C>, report: Report) {
    this.scenario = scenario;
    this.context = context;
    this.report = report;
  }

  static async up<C extends Record<string, ClientSpec>>(scenario: Scenario<C>): Promise<ScenarioRun<C>> {
    const stand = await createStand(scenario.stand);
    const report = new Report(scenario.name, stand);
    const clients: Clients = {};
    for (const [name, spec] of Object.entries(scenario.clients)) {
      const open = (): Promise<HubConnection> => HubConnection.open(report.record(name, inProcessTransport(stand.hub)), name, undefined, spec.kind === "tui" ? ["component-bridge"] : undefined);
      switch (spec.kind) {
        case "tui":
          clients[name] = await TuiDriver.start(open, { cwd: stand.project, columns: spec.columns, rows: spec.rows });
          break;
        case "raw":
          clients[name] = await RawDriver.open(open);
          break;
        case "web":
          // the page's connections go through the web app's relay, recorded like the others
          clients[name] = await WebDriver.start(async () => report.record(name, inProcessTransport(stand.hub)), { width: spec.columns, height: spec.rows });
          break;
        default:
          throw new Error(`unknown client kind: ${String(spec.kind satisfies never)}`);
      }
    }
    report.clients = clients;
    return new ScenarioRun(scenario, { stand, clients: clients as ScenarioContext<C>["clients"], memo: {} }, report);
  }

  get done(): boolean {
    return this.next >= this.scenario.steps.length;
  }

  /** Runs the next step; on failure writes the report and rethrows. */
  async step(): Promise<Step<C>> {
    const step = this.scenario.steps[this.next];
    if (step === undefined) {
      throw new Error(`${this.scenario.name}: no steps left`);
    } else {
      try {
        // a hang fails the step here, so the report is written before the test runner gives up
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hang = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`step "${step.name}" hung for ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS);
        });
        await Promise.race([step.run(this.context), hang]).finally(() => clearTimeout(timer));
        this.next += 1;
        await this.report.passed(step.name);
        return step;
      } catch (error) {
        await this.report.failed(step.name, error);
        throw error;
      }
    }
  }

  async until(name: string | undefined): Promise<void> {
    while (!this.done && this.scenario.steps[this.next]?.name !== name) {
      await this.step();
    }
  }

  async down(): Promise<void> {
    for (const client of Object.values(this.context.clients) as Driver[]) {
      client.stop();
    }
    await this.context.stand.down();
  }
}

/** The scenario under hub's test runner: a suite with one test per step. */
export function runScenario<C extends Record<string, ClientSpec>>(scenario: Scenario<C>): void {
  if (process.env.HARNESS_TEST_HOST === "1") {
    return; // loaded by the stand host of `harness-test up`, which runs the steps itself
  } else {
    // under the test runner
  }
  describe(scenario.name, () => {
    let run: ScenarioRun<C>;
    before(async () => {
      run = await ScenarioRun.up(scenario);
    });
    after(async () => {
      await run?.down();
    });
    for (const step of scenario.steps) {
      // the timeout only guards against a hang: a step waits for events, never for time
      test(step.name, { timeout: 60_000 }, async () => {
        if (run.scenario.steps[run.next] !== step) {
          throw new Error(`skipped: an earlier step failed (${run.scenario.steps[run.next]?.name ?? "?"})`);
        } else {
          await run.step();
        }
      });
    }
  });
}
