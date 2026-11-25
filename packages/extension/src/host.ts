// What the harness extension needs from the process that runs it (harness-agent, or a test).
// The extension never talks to clients, nodes or transports: it asks the operator through
// `interactions`, publishes its state through `publishState`, and spawns subagents through
// `spawnChild`; the host turns these into HAP records.

import type { InteractionKind, InteractionMap } from "#protocol/interactions.ts";
import type { HarnessState } from "#protocol/state.ts";

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

export type ChildSpawn = { profile: string; brief: string; cwd: string };

export type ChildHandle = { agentId: string; sessionId: string };

export interface ExtensionHost {
  readonly interactions: Interactions;
  /** The whole state after every change; the host forwards it to clients. */
  publishState(state: HarnessState): void;
  /** The user's data directory (`~/.harness`). */
  readonly dataDir: string;
  /** Asks the node for a child agent (a `harness` subagent). */
  spawnChild(spawn: ChildSpawn): Promise<ChildHandle>;
}
