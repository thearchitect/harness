// The `subagent` tool (plan 12.2): runs a profile's subagent on a self-contained brief and returns
// its handover block; or, in the background, returns at once and reports by the profile's notify.
// Only the model calls it, and only on the operator's request (prompt rule S5). Every subagent is a
// row of the session's HarnessState and a `harness-subagent` entry; the operator's steering of a
// live subagent (harness_subagent_send) reaches it here.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SUBAGENT_STEPS_SHOWN, type RunMode, type SubagentInfo, type SubagentState } from "#protocol/state.ts";
import { interruptedError, type Interrupts } from "../core/interrupts.ts";
import type { SubagentEngine, SubagentEvent, SubagentSession } from "./engine.ts";
import type { Registry, SubagentProfile } from "./registry.ts";

export const SUBAGENT_ENTRY = "harness-subagent";
export const SUBAGENT_MESSAGE_TYPE = "harness-subagent";

/** What a `harness-subagent` entry records: every change of a subagent's row. */
export type SubagentEntryData = SubagentInfo & { sessionFile?: string; background: boolean; toolCallId: string };

/** What a run of a subagent gathered: the handover block is built from it. */
export type Handover = {
  profile: string;
  engine: SubagentProfile["engine"];
  session: string;
  model?: string;
  outcome: "done" | "stopped" | "failed";
  turns: number;
  steps: string[];
  files: string[];
  operator: string[];
  denials: string[];
  costUsd: number;
  durationMs: number;
  overage: boolean;
  text: string;
  error?: string;
};

export type SubagentToolDeps = {
  registry: () => Registry;
  engines: Record<SubagentProfile["engine"], SubagentEngine>;
  interrupts: Interrupts;
  mode: () => RunMode;
  madness: () => boolean;
  /** The rows of the session's subagents (HarnessState). */
  rows: () => SubagentInfo[];
  publish: (rows: SubagentInfo[]) => void;
  /** Profiles this agent may call (a subagent: its own list); undefined: every loaded profile. */
  callable?: string[];
};

export function handoverText(handover: Handover): string {
  const seconds = Math.round(handover.durationMs / 1000);
  return [
    `Subagent ${handover.profile} (${handover.engine}) — session ${handover.session}${handover.model !== undefined ? `, model ${handover.model}` : ""}`,
    `State: ${handover.outcome}; ${handover.turns} turns, ${handover.steps.length} steps, ${seconds}s, $${handover.costUsd.toFixed(4)}${handover.overage ? ", usage credits used" : ""}`,
    ...(handover.files.length > 0 ? [`Files changed: ${[...new Set(handover.files)].join(", ")}`] : []),
    ...handover.operator.map((text) => `Operator → ${handover.profile}: ${text}`),
    ...(handover.denials.length > 0 ? [`Refused: ${handover.denials.join("; ")}`] : []),
    ...(handover.error !== undefined ? [`Error: ${handover.error}`] : []),
    "",
    "Report:",
    handover.text !== "" ? handover.text : "(no final text)",
  ].join("\n");
}

/** A subagent run in progress: its row, its gathered story, the end of its run. */
class Run {
  readonly session: SubagentSession;
  readonly profile: SubagentProfile;
  readonly background: boolean;
  readonly toolCallId: string;
  readonly startedAt = Date.now();
  readonly handover: Handover;
  private readonly finishedListeners = new Set<(handover: Handover) => void>();
  private readonly changeListeners = new Set<() => void>();
  waiting = false;
  ended = false;

  constructor(session: SubagentSession, profile: SubagentProfile, background: boolean, toolCallId: string) {
    this.session = session;
    this.profile = profile;
    this.background = background;
    this.toolCallId = toolCallId;
    this.handover = {
      profile: profile.name,
      engine: profile.engine,
      session: session.info.session,
      outcome: "done",
      turns: 0,
      steps: [],
      files: [],
      operator: [],
      denials: [],
      costUsd: 0,
      durationMs: 0,
      overage: false,
      text: "",
    };
    session.onEvent((event) => this.apply(event));
  }

  apply(event: SubagentEvent): void {
    switch (event.kind) {
      case "init":
        this.handover.model = event.model;
        break;
      case "step":
        this.handover.steps.push(event.summary);
        break;
      case "text":
        this.handover.text = event.text;
        break;
      case "file":
        this.handover.files.push(event.path);
        break;
      case "waiting":
        this.waiting = event.waiting;
        break;
      case "operator":
        this.handover.operator.push(event.text);
        break;
      case "denial":
        this.handover.denials.push(`${event.tool}: ${event.reason}`);
        break;
      case "usage":
        this.handover.costUsd += event.costUsd;
        break;
      case "rate_limit_wait":
      case "rate_limit_over":
      case "task":
        break; // the claude engine shows these through its own interactions and tasks
      case "overage":
        this.handover.overage = true;
        break;
      case "result":
        this.ended = true;
        this.waiting = false;
        this.handover.outcome = event.outcome;
        this.handover.turns = event.turns ?? this.handover.turns;
        this.handover.text = event.text !== "" ? event.text : this.handover.text;
        this.handover.durationMs = Date.now() - this.startedAt;
        if (event.error !== undefined) {
          this.handover.error = event.error;
        } else {
          // no error
        }
        for (const listener of this.finishedListeners) {
          listener(this.handover);
        }
        break;
      default:
        throw new Error(`unknown subagent event: ${JSON.stringify(event satisfies never)}`);
    }
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  get state(): SubagentState {
    return this.ended ? (this.handover.outcome === "done" ? "done" : this.handover.outcome) : this.waiting ? "waiting" : "running";
  }

  onFinished(listener: (handover: Handover) => void): void {
    this.finishedListeners.add(listener);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  finished(signal: AbortSignal): Promise<Handover> {
    return new Promise((resolve, reject) => {
      if (this.ended) {
        resolve(this.handover);
      } else if (signal.aborted) {
        reject(new Error("Subagent stopped"));
      } else {
        this.onFinished(resolve);
      }
    });
  }
}

export class Subagents {
  private readonly pi: ExtensionAPI;
  private readonly deps: SubagentToolDeps;
  /** Live runs by session id. */
  private readonly runs = new Map<string, Run>();

  constructor(pi: ExtensionAPI, deps: SubagentToolDeps) {
    this.pi = pi;
    this.deps = deps;
  }

  private row(run: Run): SubagentInfo {
    return {
      session: run.session.info.session,
      profile: run.profile.name,
      engine: run.profile.engine,
      state: run.state,
      ...(run.session.info.agentId !== undefined ? { agentId: run.session.info.agentId } : {}),
      ...(run.handover.model !== undefined ? { model: run.handover.model } : {}),
      startedAt: run.startedAt,
      ...(run.ended ? { endedAt: run.startedAt + run.handover.durationMs } : {}),
      costUsd: run.handover.costUsd,
      steps: run.handover.steps.slice(-SUBAGENT_STEPS_SHOWN),
      ...(run.handover.text !== "" ? { text: run.handover.text } : {}),
    };
  }

  private publish(run: Run): void {
    const row = this.row(run);
    this.deps.publish([...this.deps.rows().filter((candidate) => candidate.session !== row.session), row]);
  }

  private record(run: Run): void {
    this.pi.appendEntry<SubagentEntryData>(SUBAGENT_ENTRY, { ...this.row(run), sessionFile: run.session.info.sessionFile, background: run.background, toolCallId: run.toolCallId });
  }

  /** The last recorded row of a profile's session (to continue it). */
  private recorded(ctx: ExtensionContext, profile: string, session?: string): SubagentEntryData | undefined {
    const entries = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_ENTRY)
      .map((entry) => (entry as { data?: SubagentEntryData }).data)
      .filter((data): data is SubagentEntryData => data !== undefined && data.profile === profile && (session === undefined || data.session === session));
    return entries.at(-1);
  }

  /** The operator's message to a live subagent (C12): taken at its next turn boundary. */
  async steer(session: string, text: string): Promise<void> {
    const run = this.runs.get(session);
    if (run === undefined || run.ended) {
      throw new Error(`subagent session ${session} is not running: only the calling model can continue it`);
    } else {
      await run.session.send(text, "operator");
    }
  }

  /** Stops every live run (the session ends, or "/-" on a call). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.values()].filter((run) => !run.ended && !run.background).map((run) => run.session.interrupt().catch(() => undefined)));
  }

  register(): void {
    const names = this.deps.callable ?? [...this.deps.registry().profiles.keys()];
    if (names.length === 0) {
      return; // no profiles: no tool
    } else {
      this.registerTool(names);
    }
  }

  private registerTool(names: string[]): void {
    const profiles = names.map((name) => this.deps.registry().profiles.get(name)).filter((profile): profile is SubagentProfile => profile !== undefined);
    this.pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: `Delegate a task to a subagent: it works in its own context on your self-contained brief and returns a handover block (its report, changed files, cost). Profiles: ${profiles.map((profile) => `${profile.name} — ${profile.description}`).join("; ")}.`,
      promptSnippet: "Delegate a task to a subagent (only on the operator's explicit request)",
      parameters: Type.Object({
        agent: Type.Union(
          names.map((name) => Type.Literal(name)),
          { description: "The subagent profile" },
        ),
        task: Type.String({ description: "A self-contained brief: the subagent sees nothing of this conversation. When continuing: what to do next and what changed since it stopped." }),
        continue: Type.Optional(Type.Boolean({ description: "Continue this profile's last session" })),
        session: Type.Optional(Type.String({ description: "Continue this session of the profile" })),
        background: Type.Optional(Type.Boolean({ description: "Return at once; the result arrives as a notification (the profile's default when absent)" })),
      }),
      executionMode: "sequential",
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const profile = this.deps.registry().profiles.get(params.agent);
        if (profile === undefined) {
          throw new Error(`no subagent profile ${params.agent}`);
        } else if (params.continue === true && params.session !== undefined) {
          throw new Error("continue and session exclude each other");
        } else {
          const recorded = params.continue === true || params.session !== undefined ? this.recorded(ctx, profile.name, params.session) : undefined;
          if ((params.continue === true || params.session !== undefined) && recorded === undefined) {
            throw new Error(params.session !== undefined ? `no session ${params.session} of ${profile.name} here` : `${profile.name} has no session here to continue`);
          } else {
            const background = params.background ?? profile.background;
            const live = recorded !== undefined ? this.runs.get(recorded.session) : undefined;
            const run = live !== undefined && !live.ended ? live : await this.start(profile, ctx, toolCallId, background, recorded);
            const update = (): void => onUpdate?.({ content: [{ type: "text", text: `${profile.name}: ${run.handover.steps.length} steps` }], details: { handover: { ...run.handover }, state: run.state } });
            await run.session.send(params.task, "caller");
            if (background) {
              return {
                content: [{ type: "text", text: `Started subagent ${profile.name} in the background, session ${run.session.info.session}. Its result arrives as a notification.` }],
                details: { handover: run.handover, state: run.state, background: true },
              };
            } else {
              const interrupt = this.deps.interrupts.register(toolCallId);
              const stop = (): void => void run.session.interrupt().catch(() => undefined);
              const aborted = signal !== undefined ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal;
              aborted.addEventListener("abort", stop, { once: true });
              const offUpdate = run.onChange(update);
              try {
                const handover = await run.finished(aborted).catch(async (error: unknown) => {
                  await run.finished(new AbortController().signal); // the stopped run still reports
                  throw error;
                });
                const reason = interrupt.reason();
                const text = handoverText(handover);
                if (reason !== undefined) {
                  throw interruptedError(new Error(`${text}\n\nSubagent stopped.`), reason);
                } else {
                  return { content: [{ type: "text", text }], details: { handover, state: run.state } };
                }
              } finally {
                offUpdate();
                aborted.removeEventListener("abort", stop);
                this.deps.interrupts.release(toolCallId);
              }
            }
          }
        }
      },
    });
  }

  private async start(profile: SubagentProfile, ctx: ExtensionContext, toolCallId: string, background: boolean, recorded: SubagentEntryData | undefined): Promise<Run> {
    const mode = profile.mode === "inherit" ? this.deps.mode() : profile.mode;
    const session = await this.deps.engines[profile.engine].start({
      profile,
      cwd: ctx.cwd,
      mode,
      madness: this.deps.madness(),
      ...(recorded !== undefined ? { resume: { session: recorded.session, sessionFile: recorded.sessionFile } } : {}),
      background,
      ctx,
      toolCallId,
    });
    const run = new Run(session, profile, background, toolCallId);
    this.runs.set(session.info.session, run);
    this.publish(run);
    this.record(run);
    run.onChange(() => this.publish(run));
    run.onFinished((handover) => {
      this.record(run);
      this.runs.delete(session.info.session);
      void session.detach().catch(() => undefined);
      if (background) {
        this.notify(profile, handover);
      } else {
        // the tool call returns the handover
      }
    });
    return run;
  }

  /**
   * The session opens again: subagents recorded as live were stopped with the old agent, except
   * background `harness` ones, which outlive it — followed again if still running, reported if they
   * finished meanwhile.
   */
  async restore(ctx: ExtensionContext): Promise<void> {
    const rows = recordedRows(ctx);
    this.deps.publish(rows.map(({ sessionFile: _file, background: _background, toolCallId: _call, ...row }) => row));
    for (const row of rows.filter((candidate) => candidate.state === "running" || candidate.state === "waiting")) {
      const profile = this.deps.registry().profiles.get(row.profile);
      if (!row.background || row.engine !== "harness" || profile === undefined || this.runs.has(row.session)) {
        this.pi.appendEntry<SubagentEntryData>(SUBAGENT_ENTRY, { ...row, state: "stopped", endedAt: Date.now() });
        this.deps.publish(this.deps.rows().map((candidate) => (candidate.session === row.session ? { ...candidate, state: "stopped" } : candidate)));
      } else {
        try {
          const run = await this.start(profile, ctx, row.toolCallId, true, row);
          if (!run.session.info.running) {
            // it finished while nobody followed it
            const text = await run.session.lastText();
            run.apply({ kind: "result", outcome: "done", text });
            await run.session.close();
          } else {
            // still running: its end reports as usual
          }
        } catch (error) {
          ctx.ui.notify(`subagent ${row.profile} ${row.session}: not followed again: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
    }
  }

  private notify(profile: SubagentProfile, handover: Handover): void {
    const message = { customType: SUBAGENT_MESSAGE_TYPE, content: `Background subagent finished.\n\n${handoverText(handover)}`, display: true, details: { handover } };
    switch (profile.notify) {
      case "wake":
        this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
        break;
      case "queue":
        this.pi.sendMessage(message, { deliverAs: "nextTurn" });
        break;
      case "none":
        break; // the row shows it; nobody is told
      default:
        throw new Error(`unknown notify policy: ${String(profile.notify satisfies never)}`);
    }
  }
}

/** The rows of the session's subagents as its entries recorded them (the last record of each session). */
export function recordedRows(ctx: ExtensionContext): SubagentEntryData[] {
  const rows = new Map<string, SubagentEntryData>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === SUBAGENT_ENTRY) {
      const data = (entry as { data?: SubagentEntryData }).data;
      if (data !== undefined) {
        rows.set(data.session, data);
      } else {
        // an empty record
      }
    } else {
      // not a subagent record
    }
  }
  return [...rows.values()];
}
