// The agent's side of operator interactions: each ask becomes a harness_interaction_request on the
// stream and stays open until a client answers it (first answer wins), its signal aborts, or the
// agent shuts down. Clients that connect later get the open ones in their snapshot.

import { randomUUID } from "node:crypto";
import type { InteractionCloseReason, InteractionKind, InteractionMap, InteractionRequest } from "#protocol/interactions.ts";
import type { HapEvent } from "#protocol/hap.ts";
import type { AskOptions, Interactions } from "#extension/host.ts";

type Pending = { request: InteractionRequest; resolve(answer: unknown): void };

export class InteractionHub implements Interactions {
  private readonly pending = new Map<string, Pending>();
  private readonly emit: (event: HapEvent) => void;

  constructor(emit: (event: HapEvent) => void) {
    this.emit = emit;
  }

  ask<K extends InteractionKind>(kind: K, payload: InteractionMap[K]["payload"], options?: AskOptions): Promise<InteractionMap[K]["answer"] | undefined> {
    if (options?.signal?.aborted === true) {
      return Promise.resolve(undefined);
    } else {
      const request = { id: randomUUID(), kind, payload, toolCallId: options?.toolCallId, openedAt: Date.now() } as InteractionRequest;
      return new Promise((resolve) => {
        const onAbort = (): void => this.close(request.id, "cancelled", undefined);
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        this.pending.set(request.id, {
          request,
          resolve: (answer) => {
            options?.signal?.removeEventListener("abort", onAbort);
            resolve(answer as InteractionMap[K]["answer"] | undefined);
          },
        });
        this.emit({ type: "harness_interaction_request", request });
      });
    }
  }

  /** A client's answer; false when the interaction is no longer open (another client answered first). */
  answer(interactionId: string, answer: unknown): boolean {
    if (this.pending.has(interactionId)) {
      this.close(interactionId, "answered", answer);
      return true;
    } else {
      return false;
    }
  }

  open(): InteractionRequest[] {
    return [...this.pending.values()].map((pending) => pending.request);
  }

  /** Closes everything still open: the agent is shutting down. */
  endAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.close(id, "ended", undefined);
    }
  }

  private close(id: string, reason: InteractionCloseReason, answer: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      // already closed
    } else {
      this.pending.delete(id);
      this.emit({ type: "harness_interaction_closed", interactionId: id, reason });
      pending.resolve(answer);
    }
  }
}
