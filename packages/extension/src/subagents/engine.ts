// The engines of subagents (plan 12.2): `harness` (a child agent on the node) and `claude` (Claude
// Code). Both turn their own streams into the same SubagentEvents, from which the `subagent` tool
// builds its progress, the HarnessState row and the handover block.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunMode, TaskState } from "#protocol/state.ts";
import type { SubagentProfile } from "./registry.ts";

export type SubagentEvent =
  /** The subagent runs: the model it actually uses, once known. */
  | { kind: "init"; model?: string }
  | { kind: "step"; tool: string; summary: string }
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "waiting"; waiting: boolean }
  | { kind: "operator"; text: string }
  | { kind: "denial"; tool: string; reason: string }
  | { kind: "usage"; costUsd: number }
  | { kind: "rate_limit_wait"; window: string; resetsAt?: number }
  | { kind: "rate_limit_over" }
  | { kind: "overage" }
  | { kind: "task"; id: string; state: TaskState; command?: string; outputFile?: string; /** The call that started it (Claude's Task or Bash). */ toolUseId?: string }
  | { kind: "result"; outcome: "done" | "stopped" | "failed"; text: string; turns?: number; error?: string };

export type SubagentStart = {
  profile: SubagentProfile;
  cwd: string;
  /** The mode of the subagent's runs (the profile's, or the caller's for `inherit`). */
  mode: RunMode;
  madness: boolean;
  /** Continue this session of the profile; a new one when absent. */
  resume?: { session: string; sessionFile?: string };
  background: boolean;
  /** The calling tool call: its context runs gates and harness tools for the subagent. */
  ctx: ExtensionContext;
  toolCallId: string;
};

export interface SubagentSession {
  readonly engine: SubagentProfile["engine"];
  /** Its session (pi's or Claude Code's), and for `harness` the child's file and agent. */
  readonly info: { session: string; sessionFile?: string; agentId?: string; running: boolean };
  /** The subagent's last answer (a background subagent that finished while nobody followed it). */
  lastText(): Promise<string>;
  onEvent(listener: (event: SubagentEvent) => void): () => void;
  /** The instruction (with its plan), a follow-up, or the operator's steering: the next message of the subagent. */
  send(text: string, from: "caller" | "operator"): Promise<void>;
  /** Stops the run in flight (its result comes as a `stopped` result). */
  interrupt(): Promise<void>;
  stopTask(id: string): Promise<void>;
  /** Stops following the subagent (a background one keeps running). */
  detach(): Promise<void>;
  /** Ends the subagent's process. */
  close(): Promise<void>;
}

export interface SubagentEngine {
  start(start: SubagentStart): Promise<SubagentSession>;
}
