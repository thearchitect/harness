// What the harness extension needs from the process that runs it (harness-agent, or a test).
// The extension never talks to clients, hubs or transports: it asks the operator through
// `interactions`, publishes its state through `publishState`, and starts subagents' agents through
// `children`; the host turns these into HAP records and hub requests.

import type { InteractionKind, InteractionMap } from "#protocol/interactions.ts";
import type { HarnessState, SubagentLaunch } from "#protocol/state.ts";
import type { TranscriptEntry, TranscriptMessage } from "#protocol/claude-transcript.ts";

export type AskOptions = {
  /** Closes the interaction (reason "cancelled") when aborted; the ask then resolves undefined. */
  signal?: AbortSignal;
  /** The tool call the interaction belongs to, for clients that draw it inside the tool row. */
  toolCallId?: string;
};

export interface Interactions {
  /**
   * Opens an interaction and waits for the operator. Resolves with the answer, or undefined when
   * the interaction closed unanswered (signal aborted, agent shutting down).
   */
  ask<K extends InteractionKind>(kind: K, payload: InteractionMap[K]["payload"], options?: AskOptions): Promise<InteractionMap[K]["answer"] | undefined>;
}

/** A child agent's record (pi's events and harness's records, as HAP carries them). */
export type ChildRecord = { type: string; [key: string]: unknown };

export type ChildLaunch = {
  cwd: string;
  /** Continue this stored session of the subagent; a new session when absent. */
  sessionFile?: string;
  /** Outlives the parent's agent (finishes and reports later). */
  background: boolean;
  subagent: Omit<SubagentLaunch, "depth">;
};

/** A subagent's agent on the hub, followed by its parent. */
export interface ChildAgent {
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  /** Whether a run of the child was on when it was followed (a continued background subagent). */
  readonly running: boolean;
  /** Every record of the child from now on. */
  onRecord(listener: (record: ChildRecord) => void): () => void;
  /** A HAP request or pi command for the child; resolves with its answer. */
  call<T = unknown>(record: { type: string; [key: string]: unknown }): Promise<T>;
  /** Stops following the child; it keeps running. */
  detach(): Promise<void>;
  /** Stops the child's agent (its session stays). */
  close(): Promise<void>;
}

export interface ChildAgents {
  start(launch: ChildLaunch): Promise<ChildAgent>;
}

export interface ExtensionHost {
  readonly interactions: Interactions;
  /** The whole state after every change; the host forwards it to clients. */
  publishState(state: HarnessState): void;
  /** A `claude` subagent's transcript changed: these entries (new or updated), the message being streamed. */
  publishClaude(session: string, entries: TranscriptEntry[], streaming: TranscriptMessage | null): void;
  /** The user's data directory (`~/.harness`). */
  readonly dataDir: string;
  /** Agents of subagents (engine `harness`), started through the hub. */
  readonly children: ChildAgents;
  /** This agent's own launch when it runs as a subagent. */
  readonly subagent: SubagentLaunch | undefined;
}
