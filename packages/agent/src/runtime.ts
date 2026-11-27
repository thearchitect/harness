// The pi runtime of one harness-agent, built the way pi's own CLI builds it (main.js:
// createAgentSessionServices → createAgentSessionFromServices → createAgentSessionRuntime), without
// pi's CLI arguments: the harness extension and the bundled pi packages come in as factories and
// paths, project trust comes from pi's trust store.

import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export type RuntimeOptions = {
  cwd: string;
  /** The user's data directory (`~/.harness`): pi settings, auth, sessions. */
  agentDir: string;
  /** Open this session file; a new session in `cwd` otherwise. */
  sessionFile?: string;
  /** Parent session of a new session (a subagent's). */
  parentSession?: string;
  /** In-process extensions: the harness extension and pi's built-in codemode and MCP come first. */
  extensionFactories: ExtensionFactory[];
  /** Extensions loaded from disk: the bundled pi packages. */
  extensionPaths: string[];
  /** Skill files or directories added to discovery. */
  skillPaths: string[];
  /** A link for the operator's browser (an MCP server's sign-in): the clients open it where they run, not the hub. */
  openUrl: (url: string) => void;
};

export async function createHarnessRuntime(options: RuntimeOptions): Promise<AgentSessionRuntime> {
  const trustStore = new ProjectTrustStore(options.agentDir);
  const extensionFactories: ExtensionFactory[] = [createCodemodeExtension(), createMcpExtension({ openUrl: options.openUrl }), ...options.extensionFactories];

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const projectTrusted = trustStore.get(cwd) ?? !hasTrustRequiringProjectResources(cwd);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        packageCommandOutput: "inherit",
        additionalExtensionPaths: options.extensionPaths,
        additionalSkillPaths: options.skillPaths,
        extensionFactories,
      },
    });
    const diagnostics = [
      ...services.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
        type: "error" as const,
        message: `Failed to load extension "${path}": ${error}`,
      })),
    ];
    // codemode joins the default tools; tool_search stays out (its declarations would change the
    // declared set mid-session and miss the provider's prompt cache).
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: ["+codemode"],
      excludeTools: ["tool_search"],
    });
    if (created.modelFallbackMessage !== undefined && created.session.model !== undefined) {
      diagnostics.push({ type: "warning", message: created.modelFallbackMessage });
    } else {
      // the session's own model was restored, or there is no model at all (reported by the host)
    }
    return { ...created, services, diagnostics };
  };

  let sessionManager: SessionManager;
  {
    const sessionDir = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false }).getSessionDir();
    if (options.sessionFile !== undefined) {
      sessionManager = SessionManager.open(options.sessionFile, sessionDir);
    } else {
      sessionManager = SessionManager.create(options.cwd, sessionDir, options.parentSession === undefined ? undefined : { parentSession: options.parentSession });
    }
  }

  return createAgentSessionRuntime(createRuntime, { cwd: sessionManager.getCwd(), agentDir: options.agentDir, sessionManager });
}
