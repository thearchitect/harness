// "/-" (harness_interrupt): stops the long tool calls in flight — bash commands, waits on
// background tasks, subagent runs — without aborting the run, and records the operator's reason so
// each stopped call can say why. The message itself is steered to the model separately.

export type Interrupt = { readonly signal: AbortSignal; reason(): string | undefined };

type Handle = { controller: AbortController; reason?: string };

export class Interrupts {
  private readonly handles = new Map<string, Handle>();

  /** A handle for one tool call; release it when the call ends. */
  register(toolCallId: string): Interrupt {
    const handle: Handle = { controller: new AbortController() };
    this.handles.set(toolCallId, handle);
    return { signal: handle.controller.signal, reason: () => handle.reason };
  }

  release(toolCallId: string): void {
    this.handles.delete(toolCallId);
  }

  /** Interrupts every registered call; returns how many were running. */
  interruptAll(reason: string): number {
    let interrupted = 0;
    for (const handle of this.handles.values()) {
      if (handle.controller.signal.aborted) {
        // already interrupted by an earlier "/-"
      } else {
        handle.reason = reason;
        handle.controller.abort();
        interrupted += 1;
      }
    }
    return interrupted;
  }

  clear(): void {
    this.handles.clear();
  }
}

/** The error of an interrupted call, carrying the operator's reason. */
export function interruptedError(error: unknown, reason: string | undefined): unknown {
  if (reason !== undefined && error instanceof Error) {
    const separator = error.message.endsWith(".") ? " " : ". ";
    return new Error(`${error.message}${separator}Aborted by user. User-provided abort reason: ${reason}`);
  } else {
    return error;
  }
}
