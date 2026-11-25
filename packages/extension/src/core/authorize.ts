// The change review shared by write/edit, lsp_refactor and subagent file changes: one decision per
// change. Madness lets everything through; otherwise the farthest path decides (gate.ts): scratch
// space is free, PLAN refuses, SIMPLE writes the current directory freely, the rest asks the
// operator through the `gate` interaction (Allow / Allow with comment / Reject with comment / Stop).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import type { RunMode } from "#protocol/state.ts";
import type { GateKind } from "#protocol/interactions.ts";
import type { Interactions } from "../host.ts";
import { changeReview, clipDetail, GATE_TITLE, type ChangeReach } from "./gate.ts";
import { canonicalizeProspectivePath, isInsideRoot, sessionWorkspaceRoot } from "./paths.ts";

export type ChangeRequest = { tool: string; toolCallId: string; paths: string[]; lines: string[]; by?: string };

export type ChangeAuthorization =
  | { kind: "allowed"; comment?: string }
  | { kind: "blocked"; reason: string; terminate: boolean };

export type Authorize = (ctx: ExtensionContext, request: ChangeRequest) => Promise<ChangeAuthorization>;

export type AuthorizeDeps = {
  interactions: Interactions;
  mode(): RunMode;
  madness(): boolean;
  /** Steers the operator's comment to the running model (a gate comment reaches it twice: here and in the tool result). */
  steer(comment: string): void;
};

/** The session workspace of ctx's session. */
export function scratchWorkspaceRoot(ctx: ExtensionContext): Promise<string> {
  return sessionWorkspaceRoot(ctx.cwd, ctx.sessionManager.getHeader());
}

/** Scratch space: the system temp directory or the session workspace, free to write in every mode. */
export async function isScratchPath(ctx: ExtensionContext, path: string, workspaceRoot?: string): Promise<boolean> {
  const tempRoot = await canonicalizeProspectivePath(tmpdir());
  return (await isInsideRoot(path, ctx.cwd, tempRoot)) || (await isInsideRoot(path, ctx.cwd, workspaceRoot ?? (await scratchWorkspaceRoot(ctx))));
}

function gateKind(tool: string): GateKind {
  switch (tool) {
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "lsp_refactor":
      return "refactor";
    default:
      return "subagent";
  }
}

export function createAuthorizer(deps: AuthorizeDeps): Authorize {
  return async (ctx, request) => {
    if (deps.madness()) {
      return { kind: "allowed" };
    }

    let workspaceRoot: string | undefined;
    let reviewed: string[] = [];
    let reach: ChangeReach = "scratch";
    let resolveProblem: string | undefined;
    try {
      const root = await scratchWorkspaceRoot(ctx);
      const cwdRoot = await canonicalizeProspectivePath(ctx.cwd);
      workspaceRoot = root;
      for (const path of request.paths) {
        if (await isScratchPath(ctx, path, root)) {
          // scratch space: free in every mode
        } else if (await isInsideRoot(path, ctx.cwd, cwdRoot)) {
          reviewed.push(path);
          reach = reach === "outside" ? "outside" : "cwd";
        } else {
          reviewed.push(path);
          reach = "outside";
        }
      }
    } catch (error) {
      // a path that cannot be classified reaches anywhere
      reviewed = request.paths;
      reach = "outside";
      resolveProblem = error instanceof Error ? error.message : String(error);
    }

    const review = changeReview(deps.mode(), reach);
    switch (review) {
      case "allow":
        return { kind: "allowed" };
      case "refuse":
        return {
          kind: "blocked",
          terminate: false,
          reason:
            resolveProblem !== undefined
              ? `PLAN could not safely resolve ${request.paths.join(", ")}: ${resolveProblem}`
              : `PLAN allows ${request.tool} only inside ${tmpdir()} or your session workspace (${workspaceRoot ?? "unavailable"}). Use a disposable copy there.`,
        };
      case "ask": {
        const answer = await deps.interactions.ask(
          "gate",
          { kind: gateKind(request.tool), title: GATE_TITLE, by: request.by, paths: reviewed, detail: clipDetail(request.lines) },
          { signal: ctx.signal, toolCallId: request.toolCallId },
        );
        if (answer === undefined || answer.action === "stop") {
          // Stop or an interaction closed unanswered: reject and end the run (no steer: the run ends).
          const comment = answer?.comment;
          return { kind: "blocked", terminate: true, reason: comment ? `File change stopped by user — ${comment}` : "File change stopped by user" };
        } else if (answer.action === "reject") {
          const comment = answer.comment?.trim() ?? "";
          if (comment !== "") {
            deps.steer(comment);
          } else {
            // a bare rejection: the reason below says it
          }
          return { kind: "blocked", terminate: false, reason: comment !== "" ? `File change rejected by user — ${comment}` : "Rejected by user" };
        } else {
          const comment = answer.comment?.trim();
          if (comment) {
            deps.steer(comment);
            return { kind: "allowed", comment };
          } else {
            return { kind: "allowed" };
          }
        }
      }
      default:
        throw new Error(`unknown review: ${String(review satisfies never)}`);
    }
  };
}
