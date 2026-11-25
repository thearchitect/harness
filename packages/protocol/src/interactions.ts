// Typed requests to the operator. The agent opens one, every connected client renders it natively,
// the first answer wins and the others learn it closed. Payloads and answers are plain data, so a
// TUI, the app and a test driver render and answer the same thing.

export type GateKind = "write" | "edit" | "refactor" | "subagent";

export type GatePayload = {
  kind: GateKind;
  /** Title line, e.g. "Allow file change?". */
  title: string;
  /** Who asks: the session itself or a named subagent. */
  by?: string;
  /** Paths the change touches. */
  paths: string[];
  /** Human-readable lines of the change (a diff, a summary). */
  detail: string[];
};

export type GateAnswer = { action: "allow" | "reject" | "stop"; comment?: string };

/** `replaces`: the session already holds a value under this name. */
export type SecretPayload = { name: string; description: string; replaces: boolean };
/** The secret's value travels only in the answer and is never echoed back. */
export type SecretAnswer = { value: string } | { cancelled: true };

/** Shorter values would mask ordinary text. */
export const SECRET_MIN_LENGTH = 4;

/** Why a secret value cannot be taken, or undefined when it can; clients check before answering, the agent again. */
export function secretValueProblem(value: string): string | undefined {
  if ([...value].length < SECRET_MIN_LENGTH) {
    return `at least ${SECRET_MIN_LENGTH} characters: shorter values cannot be masked safely`;
  } else {
    return undefined;
  }
}

/**
 * ask_user's call as the model made it: pi-ask-user's parameters (question or questions, context,
 * options, allowMultiple, allowFreeform, allowComment, …). The client asks the operator and returns
 * the tool's result as pi-ask-user makes it (text for the model, details for its renderers); the
 * TUI runs pi-ask-user's own prompt, the app draws its own (packages/client/src/ask-user.ts).
 */
export type QuestionsPayload = { params: Record<string, unknown> };

export type AskUserResult = { content: { type: "text"; text: string }[]; details: unknown };

/** `error`: the call was malformed (the model reads why and calls again). */
export type QuestionsAnswer = { result: AskUserResult } | { error: string } | { cancelled: true };

export type ChoicePayload = { title: string; message?: string; options: { id: string; title: string; description?: string }[] };

export type ChoiceAnswer = { id: string } | { cancelled: true };

export type DisplayPayload = { path: string; kind: "text" | "image"; offset?: number; limit?: number; content: string };

export type DisplayAnswer = { done: true };

/** A pi extension dialog (select / confirm / input / editor) of a foreign package, typed. */
export type PiDialogPayload =
  | { method: "select"; title: string; options: string[] }
  | { method: "confirm"; title: string; message: string }
  | { method: "input"; title: string; placeholder?: string }
  | { method: "editor"; title: string; prefill?: string };

export type PiDialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export type InteractionMap = {
  gate: { payload: GatePayload; answer: GateAnswer };
  secret: { payload: SecretPayload; answer: SecretAnswer };
  questions: { payload: QuestionsPayload; answer: QuestionsAnswer };
  choice: { payload: ChoicePayload; answer: ChoiceAnswer };
  display: { payload: DisplayPayload; answer: DisplayAnswer };
  "pi-dialog": { payload: PiDialogPayload; answer: PiDialogAnswer };
};

export type InteractionKind = keyof InteractionMap;

export const INTERACTION_KINDS: readonly InteractionKind[] = ["gate", "secret", "questions", "choice", "display", "pi-dialog"];

export type InteractionRequest = {
  [K in InteractionKind]: { id: string; kind: K; payload: InteractionMap[K]["payload"]; toolCallId?: string; openedAt: number };
}[InteractionKind];

export type InteractionCloseReason = "answered" | "cancelled" | "expired" | "ended";
