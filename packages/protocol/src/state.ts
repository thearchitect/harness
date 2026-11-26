// The typed state of a harness session as every client sees it: modes, the background tasks and
// subagents, and the operator interactions it is waiting on. The agent publishes it whole after
// each change (harness_state), never as patches.

/** The variant of a session: per-message PLAN/BUILD, or the single SIMPLE mode. */
export type Variant = "advanced" | "simple";

/** The mode a run is in. */
export type RunMode = "plan" | "build" | "simple";

export type ModelRef = { ref: string; resolved: string };

export type TaskSourceKind = "own" | "claude";

export type TaskState = "running" | "exited" | "failed" | "stopped";

export type TaskInfo = {
  id: string;
  source: TaskSourceKind;
  /** The command line as started, or the description of a Claude background task. */
  command: string;
  cwd: string;
  state: TaskState;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  /** Byte length of the captured output so far. */
  outputBytes: number;
  notify: NotifyPolicy;
  /** The subagent session that owns the task (Claude background tasks). */
  owner?: string;
  /** A subagent of Claude's: the Task call that started it in its owner's transcript. */
  toolUseId?: string;
};

export type NotifyPolicy = "wake" | "queue" | "none";

export function isNotifyPolicy(value: unknown): value is NotifyPolicy {
  return value === "wake" || value === "queue" || value === "none";
}

export type SubagentEngine = "harness" | "claude";

export type SubagentState = "running" | "waiting" | "done" | "stopped" | "failed";

/**
 * How a child agent runs as a subagent: the parent resolves its profile into this, the node passes
 * it to the child (`agent_start { subagent }`) and sets `depth` from the chain of parents.
 */
export type SubagentLaunch = {
  profile: string;
  /** The profile's role: an extra system prompt section of the child. */
  role: string;
  /** The mode of every run of the child; undefined: each prompt names its mode (the parent's). */
  mode?: RunMode;
  /** A model reference (model-ref.ts) the child selects. */
  model?: string;
  /** Tool names and masks (`*`); `ctx_*` are denied always. */
  tools: { allow?: string[]; deny?: string[] };
  /** Profiles the child may call itself (the `subagent` tool only when non-empty and depth < 2). */
  subagents: string[];
  madness: boolean;
  /** 1 for a subagent of a session, 2 for a subagent's subagent; set by the node. */
  depth: number;
};

/** Subagents of subagents at most: a child of depth MAX_SUBAGENT_DEPTH cannot call subagents. */
export const MAX_SUBAGENT_DEPTH = 2;

export type SubagentInfo = {
  /** Session id of the subagent: a pi session (harness) or a Claude Code session. */
  session: string;
  profile: string;
  engine: SubagentEngine;
  state: SubagentState;
  /** The subagent's parent session in the subagent tree (undefined: the session itself). */
  parent?: string;
  /** Node agent id of a running `harness` subagent (to attach to it). */
  agentId?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
  /** The path of the plan the subagent works by (its `plan`). */
  plan?: string;
};

export type HarnessState = {
  variant: Variant;
  madness: boolean;
  /** `self` or the name of a subagent profile that implements approved plans. */
  implementer: string;
  /** The mode of the current or last run. */
  mode: RunMode;
  model?: ModelRef;
  tasks: TaskInfo[];
  subagents: SubagentInfo[];
};

export function initialHarnessState(): HarnessState {
  return { variant: "advanced", madness: false, implementer: "self", mode: "build", tasks: [], subagents: [] };
}
