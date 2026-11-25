// The records of Claude Code's headless mode (`claude -p --output-format stream-json`), as far as
// harness reads them: the documented shapes of `system`, `assistant`, `user`, `result` and the
// rate-limit and background-task messages, and the stream-json input harness writes. Unknown
// message types and fields are ignored by the reader, so newer versions do not break it.

export type ClaudeContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export type ClaudeUsage = { input_tokens?: number; output_tokens?: number };

export type ClaudeOutput =
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      model: string;
      apiKeySource?: string;
      capabilities?: string[];
      claude_code_version?: string;
      tools?: string[];
      permissionMode?: string;
    }
  | { type: "system"; subtype: "api_retry"; attempt: number; max_retries: number; retry_delay_ms: number; error_status?: number; error?: string; session_id: string }
  | { type: "system"; subtype: "task_started"; task_id: string; tool_use_id?: string; description?: string; task_type?: string; session_id: string }
  | { type: "system"; subtype: "task_updated"; task_id: string; patch: { status?: ClaudeTaskStatus; end_time?: string; error?: string }; session_id: string }
  | { type: "system"; subtype: "task_notification"; task_id: string; status: ClaudeTaskStatus; summary?: string; output_file?: string; session_id: string }
  | { type: "system"; subtype: "background_tasks_changed"; tasks: { task_id: string; status: ClaudeTaskStatus; description?: string; output_file?: string }[]; session_id: string }
  | { type: "rate_limit_event"; rate_limit_info: { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean } }
  | { type: "assistant"; message: { content: ClaudeContent[]; model?: string; usage?: ClaudeUsage }; parent_tool_use_id: string | null; session_id: string }
  | { type: "user"; message: { content: ClaudeContent[] | string }; parent_tool_use_id: string | null; session_id: string }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      result?: string;
      num_turns?: number;
      total_cost_usd?: number;
      duration_ms?: number;
      permission_denials?: { tool_name: string; tool_use_id: string; tool_input?: unknown }[];
      api_error?: string;
      session_id: string;
    }
  | { type: "control_response"; response: { subtype: "success" | "error"; request_id: string; error?: string } };

export type ClaudeTaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

/** What harness writes to Claude's stdin (`--input-format stream-json`). */
export type ClaudeInput =
  | { type: "user"; message: { role: "user"; content: { type: "text"; text: string }[] }; parent_tool_use_id: null; session_id: string }
  | { type: "control_request"; request_id: string; request: { subtype: "interrupt" } | { subtype: "stop_task"; task_id: string } };

/** The hook's input for PreToolUse and the answer harness gives (Claude Code hooks). */
export type ClaudeHookInput = { hook_event_name: string; session_id: string; tool_name: string; tool_input: Record<string, unknown>; tool_use_id?: string; cwd?: string };

export type ClaudeHookOutput = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny"; permissionDecisionReason: string } };

/** A request on the bridge socket between `harness claude-bridge` and the agent. */
export type BridgeRequest = { token: string; kind: "hook"; input: ClaudeHookInput } | { token: string; kind: "mcp"; message: unknown };
