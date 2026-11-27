// The hub's event log: ~/.harness/log/node-<name>.jsonl, one JSON object per line — what happened
// (connections, agents starting and exiting, refusals), never message texts, prompts or secrets.
// For operators and test reports; it rotates at 10 MB (the previous file keeps the suffix .1).

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const ROTATE_BYTES = 10 * 1024 * 1024;

export type TelemetryEvent =
  | { event: "hub_start"; network: boolean }
  | { event: "hub_stop" }
  | { event: "hub_restart"; connection: string }
  | { event: "connect"; connection: string; client: string; device?: string }
  | { event: "disconnect"; connection: string }
  | { event: "refused"; connection: string; code: string }
  | { event: "agent_start"; agent: string; session: string; cwd: string }
  | { event: "agent_exit"; agent: string; code: number | null; error?: string }
  | { event: "agent_unload"; agent: string }
  | { event: "terminal_started"; session: string; cwd: string; pid: number }
  | { event: "prompt_editor_opened"; session: string; command: string }
  | { event: "prompt_editor_closed"; session: string; code: number }
  | { event: "terminal_exited"; session: string; code: number }
  | { event: "network_started"; listen: string; proxy: boolean }
  | { event: "network_stopped" }
  | { event: "network_problem"; problem: string }
  | { event: "pairing_created"; pairing: string; name?: string }
  | { event: "paired"; pairing: string; device: string; address: string }
  | { event: "pairing_failed"; address: string; reason: string }
  | { event: "device_refused"; address: string; reason: string }
  | { event: "device_renamed"; device: string; to: string }
  | { event: "device_revoked"; device: string }
  | { event: "idle_exit"; minutes: number }
  | { event: "attachments_removed"; count: number };

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
      // the log is best effort: a full disk must not stop the hub
    }
  }
}
