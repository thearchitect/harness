/**
 * harness - the extension inside every harness-agent.
 *
 * Modes (PLAN/BUILD per message, or the single SIMPLE mode), madness and the implementer; the
 * change gate (core/authorize.ts) that asks the operator through the `gate` interaction; the
 * system prompt (core/prompt.ts); the run's chip and "… finished" banner; "/-"; the bundled tools
 * (tools/) and MCP servers; background tasks (supervisor/). The extension knows nothing of hubs,
 * clients or transports: it talks to the operator through the host (host.ts) and publishes its
 * HarnessState there. How things look is presentation/'s.
 */

import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, ExtensionFactory, InputEventResult, NormalizedBuildSystemPromptOptions, SessionEntry } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SUBAGENT_DEPTH, type HarnessState, type RunMode, type SubagentLaunch, type Variant } from "#protocol/state.ts";
import type { ExtensionHost } from "./host.ts";
import { createAuthorizer, isScratchPath, scratchWorkspaceRoot, type Authorize } from "./core/authorize.ts";
import { Interrupts } from "./core/interrupts.ts";
import { effectiveMode, isRunMode, modeOfText, modeSelector } from "#protocol/modes.ts";
import { assembleSystemPrompt, systemPromptProblem } from "./core/prompt.ts";
import { DEFAULTS_FILE, loadDefaults, saveDefault, type Defaults } from "./core/settings.ts";
import { bundledMcpServers, depsReport, lspToolchain, readManifest } from "./deps.ts";
import { preflight } from "./subagents/engines/claude/launch.ts";
import { resolveModelRef } from "#protocol/model-ref.ts";
import type { SubagentProfileView } from "#protocol/hap.ts";
import { entryRenderers, type FinishedEntryData, type ModeEntryData, type SystemPromptEntryData } from "./presentation/modes.ts";
import { lastModelRef, MODEL_REF_ENTRY, ModelRefs } from "./models/refs.ts";
import { ENTRY, StateStore } from "./state/store.ts";
import { declareTools, isToolAllowed, roleSection } from "./subagents/child.ts";
import { claudeEngine } from "./subagents/engines/claude/engine.ts";
import { harnessEngine } from "./subagents/engines/harness.ts";
import { loadRegistry, type Registry } from "./subagents/registry.ts";
import { Subagents } from "./subagents/tool.ts";
import { Supervisor } from "./supervisor/supervisor.ts";
import { registerTaskTools } from "./supervisor/tools.ts";
import { registerAskSecret } from "./tools/ask_secret.ts";
import { registerAskUser } from "./tools/ask_user.ts";
import { registerBuiltins } from "./tools/builtins.ts";
import { registerDisplayFile } from "./tools/display_file.ts";
import { registerLsp } from "./tools/lsp/index.ts";
import { registerProjectTree } from "./tools/project_tree.ts";
import { registerSendFile } from "./tools/send_file.ts";
import { ClaudeTranscripts } from "./subagents/engines/claude/transcripts.ts";
import { CLAUDE_NOTICE_ENTRY, CLAUDE_RESULT_ENTRY, CLAUDE_TASK_TOOLS, type ClaudeTranscript } from "#protocol/claude-transcript.ts";
import { claudeTaskRenderers } from "./presentation/claude-task.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/** Bundled MCP servers registered disabled: listed in /mcp, started only when enabled there. */
const DISABLED_MCP_SERVERS = new Set(["playwright", "chromium-devtools"]);

/** What the host drives: the agent maps HAP requests onto these. */
export type HarnessController = {
  /** The mode of the next prompt a client sends (harness_prompt names it explicitly). */
  setNextMode(mode: RunMode): void;
  set(change: { variant?: Variant; madness?: boolean; implementer?: string }): void;
  /** Selects the model a reference (plan 6.2) names now; the session follows the reference. */
  setModelRef(ref: string): Promise<{ resolved: string }>;
  /** "/-": stops the long calls in flight and steers the reason; returns how many calls stopped. */
  interrupt(reason: string): number;
  /** The operator's message to a live subagent of this session (C12). */
  steerSubagent(session: string, text: string): Promise<void>;
  /** The dependencies report: the bundle, Claude Code, the subagent profiles, bundled versions. */
  report(): Promise<string>;
  /** The subagent profiles this session may call, with their models resolved, and those left out. */
  subagentProfiles(): { profiles: SubagentProfileView[]; problems: string[] };
  /** A `claude` subagent's transcript (live, or read back from its log). */
  claudeTranscript(session: string): ClaudeTranscript;
  state(): HarnessState;
  supervisor: Supervisor;
};

type Live = { pi: ExtensionAPI; ctx: ExtensionContext | undefined };

export function createHarnessExtension(host: ExtensionHost): { factory: ExtensionFactory; controller: HarnessController } {
  const store = new StateStore((state) => host.publishState(state));
  const interrupts = new Interrupts();
  const supervisor = new Supervisor({ publish: (tasks) => store.update({ tasks }) });
  const claudeTranscripts = new ClaudeTranscripts(host.dataDir, (session, entries, streaming) => host.publishClaude(session, entries, streaming));
  const defaultsPath = join(host.dataDir, DEFAULTS_FILE);
  let live: Live | undefined;
  let nextMode: RunMode | undefined;
  let modelRefs: ModelRefs | undefined;
  let subagents: Subagents | undefined;
  let registry: Registry = { profiles: new Map(), problems: [] };
  /** The system prompt options of the current run, as every extension's before_agent_start leaves them. */
  let promptRun: NormalizedBuildSystemPromptOptions | undefined;
  const launch = host.subagent;
  const engines = {
    harness: harnessEngine(host.children),
    claude: claudeEngine({ interactions: host.interactions, dataDir: host.dataDir, mirror: (task, source) => supervisor.mirror(task, source), promptRun: () => promptRun, transcripts: claudeTranscripts }),
  };

  function rememberModel(ref: string): void {
    try {
      saveDefault(defaultsPath, "model", ref);
    } catch (error) {
      live?.ctx?.ui.notify(`harness: model not saved for new sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  function steer(text: string): void {
    live?.pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: false });
  }

  function rememberDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): void {
    try {
      saveDefault(defaultsPath, key, value);
    } catch (error) {
      live?.ctx?.ui.notify(`harness: ${key} not saved for new sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  const controller: HarnessController = {
    setNextMode(mode) {
      nextMode = mode;
    },

    set(change) {
      const current = store.current;
      const next: Partial<HarnessState> = {};
      if (change.variant !== undefined && change.variant !== current.variant) {
        live?.pi.appendEntry(ENTRY.variant, { variant: change.variant });
        rememberDefault("variant", change.variant);
        next.variant = change.variant;
      } else {
        // variant unchanged
      }
      if (change.madness !== undefined && change.madness !== current.madness) {
        live?.pi.appendEntry(ENTRY.madness, { enabled: change.madness });
        rememberDefault("madness", change.madness);
        next.madness = change.madness;
      } else {
        // madness unchanged
      }
      if (change.implementer !== undefined && change.implementer !== current.implementer) {
        // the session's own: new sessions start with `self`
        live?.pi.appendEntry(ENTRY.implementer, { implementer: change.implementer });
        next.implementer = change.implementer;
      } else {
        // implementer unchanged
      }
      store.update(next);
    },

    async setModelRef(ref) {
      if (live?.ctx === undefined || modelRefs === undefined) {
        throw new Error("no session yet");
      } else {
        const outcome = await modelRefs.apply(live.ctx, ref);
        if (!outcome.ok) {
          throw new Error(outcome.message);
        } else {
          rememberModel(ref);
          return { resolved: outcome.resolved };
        }
      }
    },

    interrupt(reason) {
      const stopped = interrupts.interruptAll(reason);
      steer(reason);
      return stopped;
    },

    async steerSubagent(session, text) {
      if (subagents === undefined) {
        throw new Error("no session yet");
      } else {
        await subagents.steer(session, text);
      }
    },

    async report() {
      const bundle = readManifest();
      const claude = await preflight(process.env.HARNESS_CLAUDE ?? "claude");
      const { profiles, problems } = controller.subagentProfiles();
      return [
        "manifest" in bundle ? `harness ${bundle.manifest.harness}` : `harness (no bundle manifest: ${bundle.problem})`,
        `Claude Code: ${claude.ok ? `${claude.version}, logged in with a Claude subscription` : claude.message}`,
        "Subagents:",
        ...profiles.map((profile) => `  ${profile.name} (${profile.engine}, ${profile.source})${profile.model !== undefined ? ` ${profile.model}${profile.resolved !== undefined ? ` → ${profile.resolved}` : ""}` : ""}`),
        ...problems.map((problem) => `  ✗ ${problem}`),
        ...("manifest" in bundle ? depsReport(bundle.manifest, []).split("\n").slice(1) : []),
      ].join("\n");
    },

    claudeTranscript(session) {
      return claudeTranscripts.get(session);
    },
    subagentProfiles() {
      const ctx = live?.ctx;
      const catalog = ctx !== undefined ? ctx.modelRegistry.getAll().map((model) => ({ provider: model.provider, id: model.id })) : [];
      return {
        profiles: [...registry.profiles.values()].map((profile) => {
          const resolved = profile.model !== undefined && profile.engine === "harness" ? resolveModelRef(profile.model, catalog) : undefined;
          return {
            name: profile.name,
            description: profile.description,
            engine: profile.engine,
            source: profile.source,
            mode: profile.mode,
            dir: profile.dir,
            ...(profile.model !== undefined ? { model: profile.model } : {}),
            ...(resolved?.ok === true ? { resolved: `${resolved.model.provider}/${resolved.model.id}` } : {}),
          };
        }),
        problems: registry.problems,
      };
    },

    state() {
      return store.current;
    },

    supervisor,
  };

  const factory: ExtensionFactory = (pi) => {
    live = { pi, ctx: undefined };
    const refs = new ModelRefs(pi, (model) => store.update({ model }));
    modelRefs = refs;

    const authorizeChange: Authorize = createAuthorizer({
      interactions: host.interactions,
      mode: () => store.current.mode,
      madness: () => store.current.madness,
      steer,
      ...(launch !== undefined ? { by: launch.profile } : {}),
    });
    const own = new Subagents(pi, {
      registry: () => registry,
      engines,
      interrupts,
      mode: () => store.current.mode,
      madness: () => store.current.madness,
      rows: () => store.current.subagents,
      publish: (rows) => store.update({ subagents: rows }),
      ...(launch !== undefined ? { callable: launch.depth < MAX_SUBAGENT_DEPTH ? launch.subagents : [] } : {}),
    });
    subagents = own;
    const loadProfiles = (ctx: ExtensionContext): void => {
      registry = loadRegistry({ cwd: ctx.cwd, dataDir: host.dataDir, projectTrusted: ctx.isProjectTrusted() });
      for (const problem of registry.problems) {
        ctx.ui.notify(`subagent profile not loaded: ${problem}`, "warning");
      }
    };
    // briefing skills of the profiles this agent may call
    pi.on("resources_discover", (_event, ctx) => {
      loadProfiles(ctx);
      const callable = launch !== undefined ? (launch.depth < MAX_SUBAGENT_DEPTH ? launch.subagents : []) : [...registry.profiles.keys()];
      return { skillPaths: callable.map((name) => registry.profiles.get(name)?.skillPath).filter((path): path is string => path !== undefined) };
    });
    // toolCallId -> the operator's comment on an approved change: opens the tool's result
    const gateComments = new Map<string, string>();
    const authorizeWithComment: Authorize = async (ctx, request) => {
      const decision = await authorizeChange(ctx, request);
      if (decision.kind === "allowed" && decision.comment !== undefined) {
        gateComments.set(request.toolCallId, decision.comment);
      } else {
        // blocked, or allowed without a comment
      }
      return decision;
    };

    registerExtensionParts(pi, host, interrupts, supervisor, authorizeWithComment);

    let cycleStart: number | undefined;
    let baselineCost = 0;
    let systemPromptShown = false;
    let promptProblemReported = false;

    pi.on("session_start", (_event, ctx) => {
      live = { pi, ctx };
      nextMode = undefined;
      cycleStart = undefined;
      baselineCost = 0;
      systemPromptShown = false;
      promptProblemReported = false;
      gateComments.clear();
      interrupts.clear();
      store.reset(launch !== undefined ? restoreChildState(store.current, launch) : restoreState(pi, ctx, defaultsPath, store.current));
      loadProfiles(ctx);
      own.register();
      void own.restore(ctx);
      // the session's model reference resolves again; a new session takes the default reference (a subagent: its profile's)
      const defaultRef = launch !== undefined ? launch.model : loadDefaults(defaultsPath).defaults.model;
      const fresh = !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
      if (fresh && defaultRef !== undefined && lastModelRef(ctx) === undefined) {
        void refs.apply(ctx, defaultRef).then((outcome) => {
          if (!outcome.ok) {
            ctx.ui.notify(`default model ${defaultRef}: ${outcome.message}`, "warning");
          } else {
            // selected
          }
        });
      } else {
        void refs.refresh(ctx);
      }
    });

    pi.on("model_select", (_event, ctx) => {
      refs.selected(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
      store.reset(launch !== undefined ? restoreChildState(store.current, launch) : restoreState(pi, ctx, defaultsPath, store.current));
    });

    pi.on("session_shutdown", (event) => {
      live = undefined;
      void own.stopAll();
      // background tasks outlive a /reload (the supervisor is the host's); another session does not inherit them
      if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
        void supervisor.stopAll(`the session changed (${event.reason})`);
      } else {
        // reload: they go on; quit: the host stops them as the agent exits
      }
    });

    pi.on("input", (event): InputEventResult => {
      // Extension-originated prompts (gate comments, task notifications) pass through verbatim.
      if (event.source === "extension") {
        return { action: "continue" };
      } else {
        const marked = modeOfText(event.text, store.current.variant);
        // a subagent's profile may fix the mode of all its runs
        const requested = launch?.mode ?? (nextMode !== undefined ? effectiveMode(nextMode, store.current.variant) : marked.mode);
        nextMode = undefined;
        // Steering and follow-up messages continue the run in its mode.
        if (event.streamingBehavior === undefined) {
          store.update({ mode: requested });
        } else {
          // the running run keeps its mode
        }
        pi.appendEntry<ModeEntryData>(ENTRY.mode, { mode: store.current.mode });
        return marked.text === event.text ? { action: "continue" } : { action: "transform", text: marked.text };
      }
    });

    pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult> => {
      cycleStart = Date.now();
      baselineCost = totalSessionCost(ctx.sessionManager.getEntries());
      const workspaceRoot = await scratchWorkspaceRoot(ctx);
      if (launch !== undefined) {
        declareTools(pi, launch);
      } else {
        // a session's own agent declares every tool
      }
      const { foreignCustomPrompt } = assembleSystemPrompt(event.systemPromptOptions, { activeTools: pi.getActiveTools(), workspaceRoot });
      promptRun = event.systemPromptOptions;
      if (launch !== undefined) {
        event.systemPromptOptions.sections.subagent_role = roleSection(launch);
      } else {
        // no role
      }
      if (foreignCustomPrompt) {
        ctx.ui.notify("[harness] SYSTEM.md (or another extension's customPrompt) appended after the harness preamble.", "info");
      } else {
        // the harness prompt alone
      }
      return {
        message: {
          customType: ENTRY.modeSelector,
          content: modeSelector(store.current.mode, store.current.implementer),
          display: false,
          details: { mode: store.current.mode } satisfies ModeEntryData,
        },
      };
    });

    pi.on("agent_start", (_event, ctx) => {
      const problem = systemPromptProblem(ctx.getSystemPrompt());
      if (problem !== undefined && !promptProblemReported) {
        promptProblemReported = true;
        console.error(`[harness] ${problem}`);
        ctx.ui.notify(`[harness] ${problem}`, "error");
      } else {
        // the harness prompt, or already reported this session
      }
      if (!systemPromptShown) {
        systemPromptShown = true;
        pi.appendEntry<SystemPromptEntryData>(ENTRY.systemPrompt, {
          text: ctx.getSystemPrompt(),
          model: ctx.model !== undefined ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
        });
      } else {
        // shown once per session
      }
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (ctx.isIdle()) {
        const now = Date.now();
        const durationMs = cycleStart !== undefined ? now - cycleStart : undefined;
        const costUsd = durationMs !== undefined ? totalSessionCost(ctx.sessionManager.getEntries()) - baselineCost : undefined;
        const leaf = ctx.sessionManager.getLeafEntry();
        const interrupted =
          leaf?.type === "message" && leaf.message.role === "assistant" && (leaf.message.stopReason === "aborted" || leaf.message.stopReason === "error");
        pi.appendEntry<FinishedEntryData>(ENTRY.finished, {
          mode: store.current.mode,
          model: ctx.model !== undefined ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          effort: ctx.thinkingLevel,
          finishedAt: now,
          durationMs,
          costUsd,
          interrupted,
        });
      } else {
        // a follow-up keeps the run going: the banner comes when it settles
      }
    });

    pi.on("tool_call", async (event, ctx) => {
      if (launch !== undefined && !isToolAllowed(launch, event.toolName)) {
        return { block: true, reason: `${event.toolName} is not among the tools of the subagent ${launch.profile}` };
      } else if (event.toolName === "write" || event.toolName === "edit") {
        const path = (event.input as { path?: unknown }).path;
        if (typeof path !== "string" || path === "") {
          return { block: true, reason: `${event.toolName} blocked: File path is required` };
        } else {
          const decision = await authorizeWithComment(ctx, {
            tool: event.toolName,
            toolCallId: event.toolCallId,
            paths: [path],
            lines: [`${event.toolName}: ${path}`],
          });
          switch (decision.kind) {
            case "allowed":
              return undefined;
            case "blocked":
              return { block: true, terminate: decision.terminate, reason: decision.reason };
            default:
              throw new Error(`unknown change decision: ${JSON.stringify(decision satisfies never)}`);
          }
        }
      } else {
        return undefined; // not a file change of the built-ins
      }
    });

    // An approved change's comment opens its result (the model sees it next to the change) and
    // stays in the details, from which every client draws it.
    pi.on("tool_result", (event) => {
      const comment = gateComments.get(event.toolCallId);
      if (comment === undefined || event.isError) {
        return undefined;
      } else {
        gateComments.delete(event.toolCallId);
        const details = typeof event.details === "object" && event.details !== null ? event.details : {};
        return {
          content: [{ type: "text", text: `✻ your comment: ${comment}` }, ...(event.content ?? [])],
          details: { ...details, gateComment: comment },
        };
      }
    });

    pi.registerCommand("madness", {
      description: "Toggle full write/edit permission bypass; new sessions start with the last choice",
      handler: async (_args, ctx) => {
        controller.set({ madness: !store.current.madness });
        ctx.ui.notify(store.current.madness ? "madness mode enabled: permission gates disabled" : "madness mode disabled: permission gates restored", "info");
      },
    });

    pi.registerCommand("simple", {
      description: "Toggle the simple mode (one mode, no PLAN/BUILD switching); new sessions start with the last choice",
      handler: async (_args, ctx) => {
        controller.set({ variant: store.current.variant === "simple" ? "advanced" : "simple" });
        ctx.ui.notify(store.current.variant === "simple" ? "simple mode: one mode from the next message on" : "advanced mode: PLAN/BUILD from the next message on", "info");
      },
    });

    pi.registerCommand("-", {
      description: "Stop the running bash call (or task wait, or subagent) and steer the message",
      handler: async (args, ctx) => {
        const text = args.trim();
        if (text === "") {
          ctx.ui.notify("Usage: /- <message>", "warning");
        } else {
          const stopped = controller.interrupt(text);
          ctx.ui.notify(stopped > 0 ? `stopped ${stopped} call(s) — message steered to the model` : "message steered to the model", "info");
        }
      },
    });

    pi.registerEntryRenderer<ModeEntryData>(ENTRY.mode, entryRenderers.mode);
    pi.registerEntryRenderer<FinishedEntryData>(ENTRY.finished, entryRenderers.finished);
    pi.registerEntryRenderer<SystemPromptEntryData>(ENTRY.systemPrompt, entryRenderers.systemPrompt);
    pi.registerEntryRenderer(MODEL_REF_ENTRY, entryRenderers.modelRef as never);

    // a `claude` subagent's transcript: its run's end, its notices, the calls of Claude's own subagents
    pi.registerEntryRenderer(CLAUDE_RESULT_ENTRY, entryRenderers.claudeResult as never);
    pi.registerEntryRenderer(CLAUDE_NOTICE_ENTRY, entryRenderers.claudeNotice as never);
    pi.registerToolRenderer((toolName, next) => (CLAUDE_TASK_TOOLS.has(toolName) ? (claudeTaskRenderers as never) : next()));
  };

  return { factory, controller };
}

/** The tools, servers, skills and commands of the bundle. */
function registerExtensionParts(pi: ExtensionAPI, host: ExtensionHost, interrupts: Interrupts, supervisor: Supervisor, authorize: Authorize): void {
  const bundle = readManifest();
  if ("manifest" in bundle) {
    for (const [name, config] of Object.entries(bundledMcpServers(bundle.manifest.bin))) {
      pi.registerMcpServer(name, { ...config, enabled: !DISABLED_MCP_SERVERS.has(name) });
    }
  } else {
    // outside the bundle (tests, a checkout without the manifest): no bundled servers
  }

  registerLsp(pi, "manifest" in bundle ? lspToolchain(bundle.manifest) : { problem: bundle.problem }, authorize, (ctx, path) => isScratchPath(ctx, path));
  registerBuiltins(pi, interrupts, host.dataDir);
  registerProjectTree(pi);
  registerSendFile(pi);
  registerAskSecret(pi, host.interactions);
  registerAskUser(pi, host.interactions);
  registerDisplayFile(pi);
  registerTaskTools(pi, supervisor, interrupts, host.dataDir);

  // `server`: only on a hub its configuration declares a shared server (HARNESS_SERVER from the hub)
  const skills = ["web-research", "testing", ...(process.env.HARNESS_SERVER === "1" ? ["server"] : [])].map((name) => join(EXTENSION_DIR, "skills", name, "SKILL.md"));
  pi.on("resources_discover", () => ({
    skillPaths: [...skills, ...("manifest" in bundle ? Object.values(bundle.manifest.skills) : [])],
  }));
}

/** A subagent's state: its launch decides madness; it never reads or writes the user's defaults. */
function restoreChildState(previous: HarnessState, launch: SubagentLaunch): HarnessState {
  return { ...previous, variant: "advanced", madness: launch.madness, implementer: "self", mode: launch.mode ?? previous.mode };
}

/** The session's state as its entries hold it; a new session takes the saved defaults and records them. */
function restoreState(pi: ExtensionAPI, ctx: ExtensionContext, defaultsPath: string, previous: HarnessState): HarnessState {
  const branch = ctx.sessionManager.getBranch();
  const last = <T>(type: string): T | undefined => {
    const entry = branch.findLast((candidate) => candidate.type === "custom" && candidate.customType === type);
    return entry?.type === "custom" ? (entry.data as T | undefined) : undefined;
  };
  const recordedVariant = last<{ variant?: unknown }>(ENTRY.variant)?.variant;
  const existing = branch.some((entry) => entry.type === "message") || recordedVariant !== undefined;
  const lastMode = last<{ mode?: unknown }>(ENTRY.mode)?.mode;
  const mode: RunMode = isRunMode(lastMode) ? lastMode : "plan";

  if (existing) {
    return {
      ...previous,
      variant: recordedVariant === "simple" ? "simple" : "advanced",
      madness: last<{ enabled?: unknown }>(ENTRY.madness)?.enabled === true,
      implementer: (() => {
        const implementer = last<{ implementer?: unknown }>(ENTRY.implementer)?.implementer;
        return typeof implementer === "string" ? implementer : "self";
      })(),
      mode,
    };
  } else {
    const { defaults, problem } = loadDefaults(defaultsPath);
    if (problem !== undefined) {
      ctx.ui.notify(`harness: defaults of new sessions not read, built-in ones used: ${problem}`, "warning");
    } else {
      // the defaults are read (or none were saved yet)
    }
    pi.appendEntry(ENTRY.variant, { variant: defaults.variant });
    pi.appendEntry(ENTRY.madness, { enabled: defaults.madness });
    pi.appendEntry(ENTRY.implementer, { implementer: "self" });
    return { ...previous, variant: defaults.variant, madness: defaults.madness, implementer: "self", mode };
  }
}

function totalSessionCost(entries: SessionEntry[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        cost += message.usage.cost.total;
      } else if (message.role === "toolResult" && message.usage !== undefined) {
        cost += message.usage.cost.total;
      } else {
        // user and custom messages cost nothing
      }
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage !== undefined) {
      cost += entry.usage.cost.total;
    } else {
      // other entries cost nothing
    }
  }
  return cost;
}
