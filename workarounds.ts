/**
 * harness - temporary workarounds for upstream gaps.
 *
 * Every mechanism here compensates for something pi or another extension does
 * not (yet) provide. Each one is meant to be deleted, not maintained, once its
 * upstream owner catches up. Rules:
 *
 * 1. Self-contained. A workaround registers its own handlers from
 *    installWorkarounds() (or, if it must be, is a named export used at exactly
 *    one call site in index.ts, marked `// WORKAROUND Wn`). No shared state
 *    with index.ts.
 * 2. Owner's slot only. A workaround writes only through public extension
 *    points, into the key its owner would write (e.g. sections.mcp_servers),
 *    and never returns `systemPrompt`. When the owner is fixed it overwrites
 *    the same key, so a stale workaround is redundant, not harmful.
 * 3. pi internals only through loadPiInternal(). Failures are logged once and
 *    the workaround is skipped; the session keeps working.
 * 4. Each block documents: Problem / Workaround / Internals used / Remove when
 *    (exact check) / Upstream issue.
 * 5. Removing a workaround = deleting its block (+ its line in
 *    installWorkarounds()). IDs are never reused.
 *
 * scripts/check-workarounds.sh runs the removal checks.
 *
 * Verified against pi-coding-agent 1.0.2 and pi-magic-context 0.45.0.
 */

import {
  getAgentDir,
  getPackageDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOG_PREFIX = "[harness workarounds]";

/** Registers all workarounds. Call once at extension load. */
export function installWorkarounds(pi: ExtensionAPI): void {
  installMcpServersSection(pi); // W1
  installThinkingBlocksVisible(pi); // W2
}

/* ----------------------------------------------------------------------------
 * Shared helper: load a module from pi's own package at runtime.
 *
 * pi's public entry point does not export some functions a workaround needs.
 * pi itself runs from dist/bundle/cli.js, but the unbundled modules ship next
 * to it under dist/. Importing one creates a separate module instance; only
 * stateless functions may be used this way.
 * ------------------------------------------------------------------------- */
const internalModules = new Map<string, Promise<Record<string, unknown> | undefined>>();

async function loadPiInternal<T>(relPath: string, exportNames: readonly string[]): Promise<T | undefined> {
  let pending = internalModules.get(relPath);
  if (!pending) {
    pending = (async () => {
      try {
        const url = pathToFileURL(join(getPackageDir(), relPath)).href;
        const mod = (await import(url)) as Record<string, unknown>;
        const missing = exportNames.filter((name) => typeof mod[name] !== "function");
        if (missing.length > 0) {
          console.warn(`${LOG_PREFIX} ${relPath}: missing exports ${missing.join(", ")}; workaround skipped`);
          return undefined;
        }
        return mod;
      } catch (error) {
        console.warn(`${LOG_PREFIX} cannot load ${relPath}; workaround skipped:`, error);
        return undefined;
      }
    })();
    internalModules.set(relPath, pending);
  }
  return (await pending) as T | undefined;
}

/* ============================================================================
 * W1 - <mcp_servers> prompt section lost behind magic-context
 *
 * Problem: pi's built-in MCP extension (loaded last, by design) lists servers
 *   whose tools are not declared to the model in
 *   systemPromptOptions.sections.mcp_servers. Its before_agent_start handler
 *   runs after pi-magic-context, which always returns a complete
 *   `systemPrompt` (forceSystemPrompt). pi then sends that text verbatim and
 *   drops every later section change, so the model never learns which MCP
 *   servers exist (codemode and tool_search do not list them).
 *   Reproduce (prints the section without MC, NONE with MC):
 *     pi -p --no-extensions -e builtin:mcp -e builtin:codemode "<print <mcp_servers> or NONE>"
 *     pi -p --no-extensions -e builtin:mcp -e builtin:codemode \
 *       -e ~/.pi/agent/npm/node_modules/@cortexkit/pi-magic-context "<same>"
 *
 * Workaround: this extension's before_agent_start runs before MC (local
 *   extensions load before packages). It renders the section with pi's own
 *   loadMcpConfig + renderServersSection and writes it into
 *   sections.mcp_servers, so MC's forced prompt includes it. Servers
 *   registered by extensions (pi.getMcpServers()) are included; a configured
 *   server with the same namespace wins, as in pi. Skipped when the built-in
 *   MCP extension is not the active /mcp provider.
 *   Limitation: a server summary comes only from its configured
 *   `description` (the built-in also falls back to the connected server's
 *   instructions, which are not visible from here).
 *
 * Internals used: dist/extensions/mcp/config.js (loadMcpConfig),
 *   dist/extensions/mcp/index.js (renderServersSection),
 *   dist/core/mcp-servers.js (mcpNamespace).
 *
 * Remove when: the MC reproduction above prints the <mcp_servers> section,
 *   i.e. MC contributes through systemPromptOptions.sections instead of
 *   returning systemPrompt (scripts/check-workarounds.sh, check W1).
 *
 * Upstream issue: not filed yet (TODO: file in cortexkit/magic-context with
 *   the reproduction above; expected fix - put the MC block into
 *   systemPromptOptions.sections, per docs/extensions.md "Prefer changing
 *   prompt sections").
 * ========================================================================== */
const MCP_SERVERS_SECTION = "mcp_servers";

type McpServerEntryLike = { name: string; config: { enabled?: boolean }; source: string; scope?: string };
type McpConfigModule = {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
    servers: McpServerEntryLike[];
  };
};
type McpIndexModule = {
  renderServersSection(servers: readonly { entry: McpServerEntryLike }[]): string | undefined;
};
type McpServersModule = { mcpNamespace(server: string): string };

function builtinMcpActive(pi: ExtensionAPI): boolean {
  return pi
    .getCommands()
    .some((command) => command.name === "mcp" && command.sourceInfo.path === "builtin:mcp");
}

function installMcpServersSection(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!builtinMcpActive(pi)) return;
    const [configModule, indexModule, serversModule] = await Promise.all([
      loadPiInternal<McpConfigModule>("dist/extensions/mcp/config.js", ["loadMcpConfig"]),
      loadPiInternal<McpIndexModule>("dist/extensions/mcp/index.js", ["renderServersSection"]),
      loadPiInternal<McpServersModule>("dist/core/mcp-servers.js", ["mcpNamespace"]),
    ]);
    if (!configModule || !indexModule || !serversModule) return;
    try {
      const configured = configModule.loadMcpConfig({
        agentDir: getAgentDir(),
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      }).servers;
      const { mcpNamespace } = serversModule;
      const configuredNamespaces = new Set(configured.map((entry) => mcpNamespace(entry.name)));
      const registered = pi
        .getMcpServers()
        .filter((server) => !configuredNamespaces.has(mcpNamespace(server.name)))
        .map((server) => ({
          name: server.name,
          config: server.config,
          source: server.extensionPath,
          scope: "extension",
        }));
      const section = indexModule.renderServersSection(
        [...configured, ...registered].map((entry) => ({ entry })),
      );
      const { sections } = event.systemPromptOptions;
      if (section) sections[MCP_SERVERS_SECTION] = section;
      else delete sections[MCP_SERVERS_SECTION];
    } catch (error) {
      console.warn(`${LOG_PREFIX} W1 failed; <mcp_servers> not rendered:`, error);
    }
  });
}

/* ============================================================================
 * W2 - thinking blocks hidden permanently by a stray Ctrl+T
 *
 * Problem: Ctrl+T (app.thinking.toggle) persists hideThinkingBlock=true into
 *   the global settings, so one accidental keypress hides thinking blocks on
 *   every later startup.
 *
 * Workaround: at extension load and on every session_start, set
 *   hideThinkingBlock back to false through the public SettingsManager
 *   (per-key locked merge, so other settings are untouched). No-op when
 *   already visible.
 *
 * Internals used: none.
 *
 * Remove when: the toggle stops persisting to settings.json, or pi offers a
 *   setting to keep it session-only. Check: grep -n -i
 *   "hideThinkingBlock|thinking.toggle" in docs/settings.md,
 *   docs/keybindings.md, CHANGELOG.md (scripts/check-workarounds.sh, check W2).
 *
 * Upstream issue: not filed.
 * ========================================================================== */
async function ensureThinkingBlocksVisible(): Promise<void> {
  try {
    const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
    if (!settings.getHideThinkingBlock()) return;
    settings.setHideThinkingBlock(false);
    await settings.flush();
  } catch (error) {
    console.warn(`${LOG_PREFIX} W2 failed:`, error);
  }
}

function installThinkingBlocksVisible(pi: ExtensionAPI): void {
  void ensureThinkingBlocksVisible();
  pi.on("session_start", () => ensureThinkingBlocksVisible());
}
