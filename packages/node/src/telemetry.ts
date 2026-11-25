// The node's event log: ~/.harness/log/node-<name>.jsonl, one JSON object per line — what happened
// (connections, agents starting and exiting, refusals), never message texts, prompts or secrets.
// For operators and test reports; it rotates at 10 MB (the previous file keeps the suffix .1).

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const ROTATE_BYTES = 10 * 1024 * 1024;

export type TelemetryEvent =
  | { event: "node_start"; roles: string[] }
  | { event: "node_stop" }
  | { event: "connect"; connection: string; client: string; user: string; trusted: boolean }
  | { event: "disconnect"; connection: string }
  | { event: "refused"; connection: string; code: string }
  | { event: "agent_start"; agent: string; session: string; cwd: string }
  | { event: "agent_exit"; agent: string; code: number | null; error?: string }
  | { event: "agent_unload"; agent: string };

export class Telemetry {
  private readonly path: string;
  private readonly now: () => number;

  constructor(dataDir: string, node: string, now: () => number) {
    const dir = join(dataDir, "log");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `node-${node}.jsonl`);
    this.now = now;
  }

  /** The last `count` events, oldest first. */
  tail(count: number): string[] {
    try {
      const lines = readFileSync(this.path, "utf8").split("\n").filter((line) => line !== "");
      return lines.slice(-count);
    } catch {
      return []; // nothing logged yet
    }
  }

  log(event: TelemetryEvent): void {
    try {
      if ((statSync(this.path, { throwIfNoEntry: false })?.size ?? 0) > ROTATE_BYTES) {
        renameSync(this.path, `${this.path}.1`);
      } else {
        // small enough
      }
      appendFileSync(this.path, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...event })}\n`);
    } catch {
      // the log is best effort: a full disk must not stop the node
    }
  }
}
