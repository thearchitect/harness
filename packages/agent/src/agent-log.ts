// The agent's log (protocol/log.ts): its records go to its hub as `harness_log` records, which the
// hub keeps under `agent` with the agent's id and session. What it tells: the start (versions, the
// session, the model, extensions and their problems), each request by the id the client and the hub
// log it under, every run (its prompt, each answer with its model, stop reason, tokens and cost, each
// tool with its result), retries and compactions, questions and their answers (a secret's value
// masked), errors with their stacks.

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { isLogLevel, Logger, type LogRecord } from "#protocol/log.ts";

type Write = (record: { type: "harness_log"; records: LogRecord[] }) => void;

export function agentLogger(write: Write): Logger {
  const level = process.env.HARNESS_LOG_LEVEL;
  return new Logger("agent", (record) => write({ type: "harness_log", records: [record] }), { level: () => (isLogLevel(level) ? level : "info") });
}

/** The text parts of a message's content. */
function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  } else if (Array.isArray(content)) {
    return content
      .flatMap((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []))
      .join("\n");
  } else {
    return "";
  }
}

/** A session event as the log keeps it; undefined for the streaming ones (debug keeps their type). */
export function logSessionEvent(log: Logger, event: AgentSessionEvent): void {
  switch (event.type) {
    case "agent_start":
      log.info("run_start");
      break;
    case "agent_end":
      log.info("run_end", { messages: event.messages.length, willRetry: event.willRetry });
      break;
    case "message_end": {
      const message = event.message as { role?: string; content?: unknown; model?: string; provider?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
      if (message.role === "assistant") {
        const usage = message.usage;
        log.log(message.errorMessage !== undefined ? "warn" : "info", "answer", {
          model: `${message.provider ?? "?"}/${message.model ?? "?"}`,
          stopReason: message.stopReason,
          tokens: { input: usage?.input, output: usage?.output, cacheRead: usage?.cacheRead, cacheWrite: usage?.cacheWrite },
          cost: usage?.cost?.total,
          text: textOf(message.content),
          ...(message.errorMessage !== undefined ? { error: message.errorMessage } : {}),
        });
      } else if (message.role === "user") {
        log.info("message", { role: "user", text: textOf(message.content) });
      } else {
        // tool results are logged with their calls (tool_execution_end)
      }
      break;
    }
    case "tool_execution_start":
      log.info("tool_start", { tool: event.toolName, call: event.toolCallId, args: event.args });
      break;
    case "tool_execution_end":
      log.log(event.isError ? "warn" : "info", "tool_end", { tool: event.toolName, call: event.toolCallId, ms: event.durationMs, isError: event.isError, result: textOf((event.result as { content?: unknown } | undefined)?.content) });
      break;
    case "auto_retry_start":
      log.warn("retry", { attempt: event.attempt, of: event.maxAttempts, delayMs: event.delayMs, error: event.errorMessage });
      break;
    case "auto_retry_end":
      log.log(event.success ? "info" : "warn", "retry_end", { success: event.success, attempt: event.attempt, ...(event.finalError !== undefined ? { error: event.finalError } : {}) });
      break;
    case "compaction_start":
      log.info("compaction_start", { reason: event.reason });
      break;
    case "compaction_end":
      log.log(event.errorMessage !== undefined ? "warn" : "info", "compaction_end", { reason: event.reason, aborted: event.aborted, ...(event.errorMessage !== undefined ? { error: event.errorMessage } : {}) });
      break;
    default:
      if (log.debugging) {
        log.debug("event", { type: event.type });
      } else {
        // streaming and bookkeeping events: their types at debug only
      }
  }
}
