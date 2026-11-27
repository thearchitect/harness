// The report of a scenario: `.test-reports/<run>/<scenario>/` (`.test-reports/latest` points at
// the newest run). Always: every client's protocol (protocol/<client>.jsonl). On a failure: report.md
// (the step, what was expected and what came, links), the agents' logs, copies of the sessions,
// each client's model state, and every client's screen at the failing step and at the last step
// that passed. Enough to understand a failure without running it again.

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Transport } from "#protocol/hub.ts";
import type { RawDriver } from "../drivers/raw.ts";
import { TuiDriver } from "../drivers/tui.ts";
import { WebDriver } from "../drivers/web.ts";
import type { Stand } from "../stand/stand.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** One id per test run: harness-test and nix/check.sh set HARNESS_TEST_RUN for all its processes. */
function runId(): string {
  const id = process.env.HARNESS_TEST_RUN ?? new Date().toISOString().replace(/[:.]/g, "-");
  process.env.HARNESS_TEST_RUN = id;
  return id;
}

export function reportsRoot(): string {
  return process.env.HARNESS_TEST_REPORTS ?? join(ROOT, ".test-reports");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

type Shots = { step: string; screens: Record<string, { text: string; ansi: string }> };

export class Report {
  readonly dir: string;
  private readonly scenario: string;
  private readonly stand: Stand;
  private readonly steps: { name: string; ok: boolean }[] = [];
  private lastPassed: Shots | undefined;
  clients: Record<string, TuiDriver | RawDriver | WebDriver> = {};

  constructor(scenario: string, stand: Stand) {
    this.scenario = scenario;
    this.stand = stand;
    const run = runId();
    const root = reportsRoot();
    this.dir = join(root, run, slug(scenario));
    mkdirSync(join(this.dir, "protocol"), { recursive: true });
    const latest = join(root, "latest");
    try {
      rmSync(latest, { force: true });
      symlinkSync(run, latest);
    } catch {
      // another process of the run linked it meanwhile
    }
  }

  /** A transport whose every frame, both ways, lands in protocol/<client>.jsonl. */
  record(client: string, transport: Transport): Transport {
    const file = join(this.dir, "protocol", `${slug(client)}.jsonl`);
    const log = (direction: "out" | "in", frame: unknown): void => appendFileSync(file, `${JSON.stringify({ at: Date.now(), [direction]: frame })}\n`);
    return {
      send: (frame) => {
        log("out", frame);
        transport.send(frame);
      },
      onFrame: (listener) =>
        transport.onFrame((frame) => {
          log("in", frame);
          listener(frame);
        }),
      onClose: (listener) => transport.onClose(listener),
      close: () => transport.close(),
    };
  }

  async passed(step: string): Promise<void> {
    this.steps.push({ name: step, ok: true });
    this.lastPassed = { step, screens: await this.texts() };
    const shots = process.env.HARNESS_TEST_SHOTS;
    if (shots === "all" || shots === step) {
      await this.shoot(step);
    } else {
      // screens only on failure or on request
    }
  }

  async failed(step: string, error: unknown): Promise<void> {
    this.steps.push({ name: step, ok: false });
    const screens = await this.shoot(step);
    if (this.lastPassed !== undefined) {
      for (const [client, screen] of Object.entries(this.lastPassed.screens)) {
        const base = join(this.dir, "screens", `${slug(this.lastPassed.step)}-${slug(client)}`);
        writeFileSync(`${base}.txt`, `${screen.text}\n`);
        writeFileSync(`${base}.ansi`, screen.ansi);
      }
    } else {
      // it failed at the first step
    }
    const models = await this.models();
    const copied = this.copyStand();
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const link = (path: string): string => `[${relative(this.dir, path)}](${relative(this.dir, path)})`;
    writeFileSync(
      join(this.dir, "report.md"),
      [
        `# ${this.scenario}: failed at "${step}"`,
        "",
        "## Steps",
        ...this.steps.map((candidate) => `- ${candidate.ok ? "✓" : "✗"} ${candidate.name}`),
        "",
        "## Error",
        "",
        "```",
        message,
        "```",
        "",
        "## Screens",
        ...screens.map((file) => `- ${link(file)}`),
        ...(this.lastPassed !== undefined ? [`- last passed step "${this.lastPassed.step}": screens/${slug(this.lastPassed.step)}-*`] : []),
        "",
        "## Models",
        ...models.map((file) => `- ${link(file)}`),
        "",
        "## Protocol, agents, sessions",
        `- ${link(join(this.dir, "protocol"))}`,
        ...copied.map((path) => `- ${link(path)}`),
        "",
      ].join("\n"),
    );
    process.stderr.write(`report: ${join(this.dir, "report.md")}\n`);
  }

  private async texts(): Promise<Shots["screens"]> {
    const screens: Shots["screens"] = {};
    for (const [name, client] of Object.entries(this.clients)) {
      if (client instanceof TuiDriver) {
        await client.settle();
        screens[name] = { text: client.text(), ansi: client.terminal.ansi };
      } else {
        // a raw client has no screen; a web client's is shot when it fails (its ARIA and PNG)
      }
    }
    return screens;
  }

  /** Every UI client's screen into screens/<step>-<client>.*; returns the files. */
  async shoot(step: string): Promise<string[]> {
    const dir = join(this.dir, "screens");
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const [name, client] of Object.entries(this.clients)) {
      if (client instanceof TuiDriver || client instanceof WebDriver) {
        files.push(...(await client.capture(dir, `${slug(step)}-${slug(name)}`).catch(() => [])));
      } else {
        // a raw client has no screen
      }
    }
    return files;
  }

  /** Each client's ClientModel and Workbench state as JSON. */
  async models(): Promise<string[]> {
    const dir = join(this.dir, "model");
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const [name, client] of Object.entries(this.clients)) {
      const file = join(dir, `${slug(name)}.json`);
      writeFileSync(file, `${JSON.stringify(await modelState(client).catch((error: unknown) => ({ error: String(error) })), null, 2)}\n`);
      files.push(file);
    }
    return files;
  }

  private copyStand(): string[] {
    const copied: string[] = [];
    for (const [from, to] of [
      [join(this.stand.dataDir, "log"), "logs"],
      [this.stand.layout.sessions, "sessions"],
    ] as const) {
      if (existsSync(from) && readdirSync(from).length > 0) {
        cpSync(from, join(this.dir, to), { recursive: true });
        copied.push(join(this.dir, to));
      } else {
        // nothing there
      }
    }
    return copied;
  }
}

/** What a client knows, as plain data: its hubs, agents, settings, and the screen it would draw. */
export async function modelState(client: TuiDriver | RawDriver | WebDriver): Promise<unknown> {
  if (client instanceof WebDriver) {
    return { screen: await client.screen() };
  } else {
    return clientState(client);
  }
}

function clientState(client: TuiDriver | RawDriver): unknown {
  const model = client.client;
  const base = {
    home: model.home,
    nodes: [...model.connections.keys()],
    offline: Object.fromEntries(model.offline),
    agents: [...model.agents.values()],
    settings: model.settings,
    full: Object.fromEntries([...model.full].map(([key, agent]) => [key, { items: agent.items.length, state: agent.state, interactions: agent.interactions, running: agent.running }])),
  };
  if (client instanceof TuiDriver) {
    const screen = client.screen();
    return {
      ...base,
      screen: {
        strips: screen.strips,
        tabs: screen.tabs.map((tab) => ({ node: tab.hub, title: tab.title, glyph: tab.glyph, mode: tab.mode, unavailable: tab.unavailable })),
        active: screen.active,
        items: screen.items,
        selected: screen.selected,
        input: screen.input,
        zones: { ...screen.zones, footer: { node: screen.zones.footer.hub }, editor: screen.zones.editor.kind === "picker" ? { kind: "picker", id: screen.zones.editor.picker.id, items: screen.zones.editor.picker.items.length } : screen.zones.editor },
      },
    };
  } else {
    return base;
  }
}
