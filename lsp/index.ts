/**
 * harness - code intelligence: a facade over the language servers of the
 * bundle (TypeScript 7, gopls, rust-analyzer).
 *
 *   tools.ts      the model's tools (lsp_*) and their formatting
 *   refactor.ts   lsp_refactor's operations, run in order; plan files
 *   generated.ts  whether a file looks generated, and why
 *   facade.ts     language-independent operations, positions by { file, line, name }
 *   workspace.ts  the session's repository and its language sessions
 *   session.ts    one server's life: start, sync with disk, requests, crashes, stop
 *   profiles/     what each language contributes (workspace model, readiness)
 *   edits.ts      server edits applied all or nothing, with diffs
 *   snapshot.ts   the files on disk and what changed since the last sync
 *   client.ts     JSON-RPC over LSP framing; the server process
 *
 * Servers start on the first call that needs them and stop with the pi
 * session (session_shutdown: reload, /new, /resume, exit).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Facade } from "./facade.ts";
import type { Toolchain } from "./profile.ts";
import { registerLspTools, type Authorize, type IsScratch } from "./tools.ts";
import { Workspace } from "./workspace.ts";

export type { Authorize, ChangeAuthorization, ChangeRequest, IsScratch } from "./tools.ts";
export type { Toolchain } from "./profile.ts";

export function registerLsp(
  pi: ExtensionAPI,
  bundle: { toolchain: Toolchain } | { problem: string },
  authorize: Authorize,
  isScratch: IsScratch,
): void {
  let workspace: Promise<Workspace> | undefined;

  const openWorkspace = (ctx: ExtensionContext): Promise<Workspace> => {
    if ("problem" in bundle) {
      return Promise.reject(new Error(`language servers are unavailable: ${bundle.problem}`));
    } else if (workspace !== undefined) {
      return workspace;
    } else {
      const opening = Workspace.open(ctx.cwd, bundle.toolchain);
      workspace = opening;
      opening.catch(() => {
        if (workspace === opening) {
          workspace = undefined;
        } else {
          // replaced meanwhile
        }
      });
      return opening;
    }
  };

  registerLspTools(pi, async (ctx) => new Facade(await openWorkspace(ctx)), authorize, isScratch);

  pi.on("session_shutdown", async () => {
    const closing = workspace;
    workspace = undefined;
    if (closing !== undefined) {
      await (await closing.catch(() => undefined))?.close();
    } else {
      // no server was started this session
    }
  });

  pi.registerCommand("lsp", {
    description: "Language servers: status and coverage (`/lsp`), restart (`/lsp restart [ts|go|rust]`)",
    handler: async (args, ctx) => {
      const [verb, language] = args.trim().split(/\s+/).filter(Boolean);
      if (verb === "restart") {
        const restarted = await (await openWorkspace(ctx)).restart(language);
        ctx.ui.notify(restarted.length > 0 ? `restarted: ${restarted.join(", ")}` : "no language server is running", "info");
      } else if (verb === undefined) {
        const opened = await openWorkspace(ctx);
        const statuses = opened.statuses();
        const lines = [
          `root: ${opened.root}${opened.inGit ? "" : " (not a git repository)"}`,
          ...(statuses.length === 0
            ? ["no language server started yet (they start on first use)"]
            : statuses.flatMap((status) => [
                `${status.name}: ${status.state}${status.reason !== undefined ? ` — ${status.reason}` : ""}`,
                ...(status.summary?.lines.map((line) => `  ${line}`) ?? []),
              ])),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        ctx.ui.notify("usage: /lsp | /lsp restart [ts|go|rust]", "warning");
      }
    },
  });
}
