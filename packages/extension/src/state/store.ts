// The session's HarnessState: one owner, published whole after every change. Its durable part
// (variant, madness, implementer, the mode of each run) lives in session entries; tasks and
// subagents are mirrored in from their own modules.

import { initialHarnessState, type HarnessState } from "#protocol/state.ts";

export const ENTRY = {
  variant: "harness-variant",
  madness: "harness-madness",
  implementer: "harness-implementer",
  mode: "harness-mode",
  finished: "harness-finished",
  systemPrompt: "harness-system-prompt",
  modelRef: "harness-model-ref",
  modeSelector: "harness-active-mode",
  task: "harness-task",
} as const;

export class StateStore {
  private state: HarnessState = initialHarnessState();
  private readonly publish: (state: HarnessState) => void;

  constructor(publish: (state: HarnessState) => void) {
    this.publish = publish;
  }

  get current(): HarnessState {
    return this.state;
  }

  update(change: Partial<HarnessState>): void {
    this.state = { ...this.state, ...change };
    this.publish(this.state);
  }

  /** Replaces the whole state (a session start) and publishes it. */
  reset(state: HarnessState): void {
    this.state = state;
    this.publish(this.state);
  }
}
