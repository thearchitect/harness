// What a hub tells every client about an agent without its whole stream: status, mode, title,
// open interactions, tasks, the outcome of the last run. Computed from the agent's HAP records.

import type { AgentSummary } from "#protocol/hub.ts";
import type { HarnessState } from "#protocol/state.ts";
import type { SessionView } from "#protocol/hap.ts";

export class SummaryTracker {
  private summary: AgentSummary;
  private readonly open = new Set<string>();

  constructor(now: number) {
    this.summary = { status: "idle", mode: "plan", title: "", waiting: 0, tasks: { running: 0, failed: 0 }, lastActivity: now, costUsd: 0 };
  }

  get current(): AgentSummary {
    return this.summary;
  }

  /** Feeds one record from the agent; true when the summary changed. */
  apply(record: { type?: unknown; [key: string]: unknown }, now: number): boolean {
    const before = JSON.stringify(this.summary);
    switch (record.type) {
      case "harness_hello":
      case "harness_session":
        this.applySession(record.session as SessionView);
        break;
      case "harness_state":
        this.applyState(record.state as HarnessState);
        break;
      case "harness_interaction_request":
        this.open.add((record.request as { id: string }).id);
        this.summary = { ...this.summary, waiting: this.open.size, lastActivity: now };
        break;
      case "harness_interaction_closed":
        this.open.delete(record.interactionId as string);
        this.summary = { ...this.summary, waiting: this.open.size };
        break;
      case "agent_start":
        this.summary = { ...this.summary, status: "running" };
        break;
      case "agent_settled":
        this.summary = { ...this.summary, status: "idle", lastOutcome: record.aborted === true ? "error" : "ok", lastActivity: now };
        break;
      case "message_end": {
        const message = record.message as { role?: string; stopReason?: string } | undefined;
        if (message?.role === "assistant" && message.stopReason === "error") {
          this.summary = { ...this.summary, lastOutcome: "error" };
        } else {
          // a normal message
        }
        break;
      }
      default:
        break; // does not change the summary
    }
    const status = this.open.size > 0 ? "waiting" : this.summary.status === "waiting" ? "running" : this.summary.status;
    this.summary = { ...this.summary, status };
    return JSON.stringify(this.summary) !== before;
  }

  private applySession(session: SessionView): void {
    const title = session.sessionName ?? this.summary.title;
    const status = session.activity === "idle" ? (this.summary.status === "running" ? "running" : this.summary.status) : "running";
    this.summary = { ...this.summary, title, costUsd: session.usage.costUsd, status: session.activity === "idle" && this.summary.status !== "running" ? "idle" : status };
  }

  private applyState(state: HarnessState): void {
    this.summary = {
      ...this.summary,
      mode: state.mode,
      tasks: {
        running: state.tasks.filter((task) => task.endedAt === undefined).length,
        failed: state.tasks.filter((task) => task.state === "failed").length,
      },
    };
  }

  /** The first user message names an untitled session. */
  titleFrom(text: string): void {
    if (this.summary.title === "") {
      this.summary = { ...this.summary, title: text.split("\n")[0]?.slice(0, 80) ?? "" };
    } else {
      // titled already
    }
  }
}
