// Model references without a version (plan 6.2, M1/M2): `anthropic/opus[:medium]` is the newest
// `opus` of the catalog when it is chosen. The session records the reference next to pi's model
// choice (`harness-model-ref`); opening the session resolves it again, so a model gone from the
// catalog gives way to its successor with a notice. Choosing an exact model drops the reference.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelRef, type ThinkingSuffix } from "#protocol/model-ref.ts";
import type { ModelRef } from "#protocol/state.ts";

export const MODEL_REF_ENTRY = "harness-model-ref";

/** `ref` undefined: the user chose an exact model; the session follows no reference. `previous`: the model the reference named before it resolved again. */
export type ModelRefEntry = { ref?: string; resolved?: string; previous?: string };

export type ModelRefOutcome = { ok: true; resolved: string; changed: boolean } | { ok: false; message: string };

function catalog(ctx: ExtensionContext): { provider: string; id: string }[] {
  return ctx.modelRegistry.getAll().map((model) => ({ provider: model.provider, id: model.id }));
}

export function lastModelRef(ctx: ExtensionContext): ModelRefEntry | undefined {
  const entry = ctx.sessionManager.getBranch().findLast((candidate) => candidate.type === "custom" && candidate.customType === MODEL_REF_ENTRY);
  return entry?.type === "custom" ? (entry.data as ModelRefEntry | undefined) : undefined;
}

export class ModelRefs {
  private readonly pi: ExtensionAPI;
  /** The reference the session follows now, for HarnessState (clients show "ref → id"). */
  private readonly publish: (model: ModelRef | undefined) => void;
  /** Set while the extension itself selects a model, so its own choice does not drop the reference. */
  private selecting = false;

  constructor(pi: ExtensionAPI, publish: (model: ModelRef | undefined) => void) {
    this.pi = pi;
    this.publish = publish;
  }

  /** Resolves `ref` and selects the model (and thinking level), recording the reference. */
  async apply(ctx: ExtensionContext, ref: string, previous?: string): Promise<ModelRefOutcome> {
    const resolved = resolveModelRef(ref, catalog(ctx));
    if (!resolved.ok) {
      return { ok: false, message: resolved.message };
    } else {
      const model = ctx.modelRegistry.find(resolved.model.provider, resolved.model.id);
      const id = `${resolved.model.provider}/${resolved.model.id}`;
      if (model === undefined) {
        return { ok: false, message: `${ref}: ${id} is not in the model registry` };
      } else {
        const changed = ctx.model?.provider !== model.provider || ctx.model?.id !== model.id;
        this.selecting = true;
        try {
          if (changed && !(await this.pi.setModel(model))) {
            return { ok: false, message: `${ref}: ${id} has no configured credentials (harness auth login)` };
          } else {
            // selected, or already the session's model
          }
        } finally {
          this.selecting = false;
        }
        this.setThinking(resolved.thinking);
        this.pi.appendEntry<ModelRefEntry>(MODEL_REF_ENTRY, { ref, resolved: id, ...(previous !== undefined && previous !== id ? { previous } : {}) });
        this.publish({ ref, resolved: id });
        return { ok: true, resolved: id, changed };
      }
    }
  }

  private setThinking(thinking: ThinkingSuffix | undefined): void {
    if (thinking !== undefined) {
      this.pi.setThinkingLevel(thinking as never);
    } else {
      // the reference names no thinking level
    }
  }

  /** Opening a session: its reference resolves again; a newer model replaces the recorded one. */
  async refresh(ctx: ExtensionContext): Promise<void> {
    const entry = lastModelRef(ctx);
    if (entry?.ref === undefined) {
      this.publish(undefined); // the session follows an exact model, or none was chosen by reference
    } else {
      const outcome = await this.apply(ctx, entry.ref, entry.resolved);
      if (!outcome.ok) {
        ctx.ui.notify(`model ${entry.ref}: ${outcome.message}; the session keeps ${entry.resolved ?? "its model"}`, "warning");
      } else if (outcome.resolved !== entry.resolved) {
        ctx.ui.notify(`${entry.ref}: ${entry.resolved ?? "?"} → ${outcome.resolved}`, "info");
      } else {
        // the same model as before
      }
    }
  }

  /** A model chosen by other means (an exact id): the session stops following its reference. */
  selected(ctx: ExtensionContext): void {
    if (!this.selecting && lastModelRef(ctx)?.ref !== undefined) {
      this.pi.appendEntry<ModelRefEntry>(MODEL_REF_ENTRY, {});
      this.publish(undefined);
    } else {
      // the reference's own choice, or no reference to drop
    }
  }
}
