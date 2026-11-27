// pi's write, edit and bash, re-registered as sequential (a batch holding one of them runs in
// order, so a dependent call sees the previous call's effect). bash additionally gets a per-call
// interrupt for "/-", the session's shell settings and the session's secrets in its environment.

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { interruptedError, type Interrupts } from "../core/interrupts.ts";
import { sessionSecrets } from "./secrets.ts";

/** `agentDir`: pi's agent directory (its settings name the shell and its prefix). */
export function registerBuiltins(pi: ExtensionAPI, interrupts: Interrupts, agentDir: string): void {
  pi.registerTool({ ...createWriteToolDefinition(process.cwd()), executionMode: "sequential" });
  pi.registerTool({ ...createEditToolDefinition(process.cwd()), executionMode: "sequential" });

  const bashTool = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...bashTool,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const interrupt = interrupts.register(toolCallId);
      try {
        const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
        const secrets = sessionSecrets.env(ctx.sessionManager.getSessionId());
        const sessionBashTool = createBashToolDefinition(ctx.cwd, {
          commandPrefix: settings.getShellCommandPrefix(),
          shellPath: settings.getShellPath(),
          spawnHook: (spawn) => ({ ...spawn, env: { ...spawn.env, ...secrets } }),
        });
        return await sessionBashTool.execute(
          toolCallId,
          params,
          signal !== undefined ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal,
          onUpdate,
          ctx,
        );
      } catch (error) {
        throw interruptedError(error, interrupt.reason());
      } finally {
        interrupts.release(toolCallId);
      }
    },
  });
}
