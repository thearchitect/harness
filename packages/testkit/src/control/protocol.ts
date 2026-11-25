// The control channel of a stand brought up by `harness-test up`: JSON lines over a unix socket
// in `.test-reports/stands/<id>.sock`, one request, one answer.

import { join } from "node:path";
import { reportsRoot } from "../report/report.ts";

export type ControlRequest =
  | { cmd: "status" }
  | { cmd: "step" }
  | { cmd: "until"; step?: string }
  | { cmd: "do"; client: string; kind: "action" | "key" | "type"; value: string }
  | { cmd: "state"; client: string }
  | { cmd: "shot"; client?: string }
  | { cmd: "logs"; lines?: number }
  | { cmd: "down" };

export type ControlAnswer = { ok: true; data: unknown } | { ok: false; error: string };

export type StandRecord = { id: string; pid: number; socket: string; scenario: string; file: string; report: string };

export function standsDir(): string {
  return join(reportsRoot(), "stands");
}
