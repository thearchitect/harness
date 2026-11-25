// ask_user's data as pi-ask-user 0.17.2 shapes it (MIT, Enzo Lucchesi; the logic below follows its
// index.ts): the questions a call asks, and the tool result an answer makes — the text the model
// reads and the details pi-ask-user's renderers draw. The TUI runs pi-ask-user's own prompt; the
// app draws its own and builds the same result here, so the model and the transcript cannot tell
// which client answered.

import type { AskUserResult } from "#protocol/interactions.ts";

export type AskOption = { title: string; description?: string };

export type AskQuestion = { question: string; context?: string; options: AskOption[]; allowMultiple: boolean; allowFreeform: boolean };

export type AskResponse = { kind: "selection"; selections: string[]; comment?: string } | { kind: "freeform"; text: string };

export type BatchAnswer = { status: "answered"; response: AskResponse } | { status: "skipped" };

/** What a call asks: one question, or a batch of 2-4 with an optional heading. */
export type AskCall = { kind: "single"; question: AskQuestion; allowComment: boolean } | { kind: "batch"; heading?: string; questions: AskQuestion[]; allowComment: boolean };

const BATCH_MIN = 2;
const BATCH_MAX = 4;
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

function coerceOption(option: unknown): AskOption | undefined {
  if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
    const title = String(option).trim();
    return title !== "" ? { title } : undefined;
  } else if (option !== null && typeof option === "object") {
    const record = option as Record<string, unknown>;
    const key = OPTION_TITLE_KEYS.find((candidate) => typeof record[candidate] === "string" && (record[candidate] as string).trim() !== "");
    const description = typeof record.description === "string" && record.description.trim() !== "" ? record.description : undefined;
    return key !== undefined ? { title: (record[key] as string).trim(), ...(description !== undefined ? { description } : {}) } : undefined;
  } else {
    return undefined;
  }
}

function options(raw: unknown, label: string): AskOption[] {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`${label}.options must be an array.`);
  } else {
    const coerced = list.map(coerceOption).filter((option): option is AskOption => option !== undefined);
    if (list.length > 0 && coerced.length === 0) {
      throw new Error(
        `All ${list.length} option(s)${label === "" ? "" : ` in ${label}`} were malformed, so nothing could be shown to the user. ` +
          `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. Call ask_user again with corrected options.`,
      );
    } else {
      return coerced;
    }
  }
}

/** The call's questions, checked as pi-ask-user checks them (each problem says how to correct the call). */
export function askCall(params: Record<string, unknown>): AskCall {
  const allowComment = params.allowComment === true;
  const heading = typeof params.question === "string" && params.question.trim() !== "" ? params.question.trim() : undefined;
  if (params.questions !== undefined && params.questions !== null) {
    const list = params.questions;
    if (!Array.isArray(list)) {
      throw new Error(`questions must be an array of ${BATCH_MIN}-${BATCH_MAX} question objects.`);
    } else if (list.length < BATCH_MIN) {
      throw new Error(`questions needs ${BATCH_MIN}-${BATCH_MAX} entries but got ${list.length}. To ask one question, use question instead.`);
    } else if (list.length > BATCH_MAX) {
      throw new Error(`questions accepts at most ${BATCH_MAX} entries but got ${list.length}. Ask the rest in a later ask_user call.`);
    } else {
      const seen = new Set<string>();
      const questions = list.map((entry: Record<string, unknown>, index): AskQuestion => {
        const label = `questions[${index}]`;
        const question = typeof entry?.question === "string" ? entry.question.trim() : "";
        if (question === "") {
          throw new Error(`${label}.question must be a non-empty string.`);
        } else if (seen.has(question.toLowerCase())) {
          throw new Error(`${label} repeats the question "${question}". Each question in a batch must be distinct.`);
        } else {
          seen.add(question.toLowerCase());
          const context = typeof entry.context === "string" && entry.context.trim() !== "" ? entry.context.trim() : undefined;
          return { question, ...(context !== undefined ? { context } : {}), options: options(entry.options, label), allowMultiple: entry.allowMultiple === true, allowFreeform: entry.allowFreeform !== false };
        }
      });
      return { kind: "batch", ...(heading !== undefined ? { heading } : {}), questions, allowComment };
    }
  } else if (typeof params.question !== "string") {
    throw new Error("ask_user needs question (one focused question) or questions (2-4 independent questions).");
  } else {
    const context = typeof params.context === "string" && params.context.trim() !== "" ? params.context.trim() : undefined;
    return {
      kind: "single",
      question: { question: params.question, ...(context !== undefined ? { context } : {}), options: options(params.options, ""), allowMultiple: params.allowMultiple === true, allowFreeform: params.allowFreeform !== false },
      allowComment,
    };
  }
}

export function responseSummary(response: AskResponse): string {
  if (response.kind === "freeform") {
    return response.text;
  } else {
    const selections = response.selections.join(", ");
    return response.comment !== undefined ? `${selections} — ${response.comment}` : selections;
  }
}

/** A selection, or a written answer; undefined when there is nothing in it. */
export function response(selections: string[], freeform: string, comment: string): AskResponse | undefined {
  const text = freeform.trim();
  const chosen = selections.map((selection) => selection.trim()).filter((selection) => selection !== "");
  const note = comment.trim();
  return text !== "" ? { kind: "freeform", text } : chosen.length > 0 ? { kind: "selection", selections: chosen, ...(note !== "" ? { comment: note } : {}) } : undefined;
}

/** The tool result of an answer (or of a dismissal: undefined), as pi-ask-user returns it. */
export function askResult(call: AskCall, answer: AskResponse | BatchAnswer[] | undefined): AskUserResult {
  if (call.kind === "single") {
    const { question, context, options: listed } = call.question;
    const base = { question, ...(context !== undefined ? { context } : {}), options: listed };
    const single = answer !== undefined && !Array.isArray(answer) ? answer : undefined;
    return single === undefined
      ? { content: [{ type: "text", text: "User cancelled the question" }], details: { ...base, response: null, cancelled: true } }
      : { content: [{ type: "text", text: `User answered: ${responseSummary(single)}` }], details: { ...base, response: single, cancelled: false } };
  } else {
    const subjects = call.questions.map(({ question, context, options: listed }) => ({ question, ...(context !== undefined ? { context } : {}), options: listed }));
    const answers = Array.isArray(answer) ? answer : undefined;
    const details = { kind: "batch", ...(call.heading !== undefined ? { heading: call.heading } : {}), questions: subjects, answers: answers ?? [], cancelled: answers === undefined };
    if (answers === undefined) {
      return { content: [{ type: "text", text: "User cancelled the questions" }], details };
    } else {
      const lines = subjects.map((subject, index) => {
        const one = answers[index];
        return `${index + 1}. ${subject.question} → ${one?.status === "answered" ? responseSummary(one.response) : "(skipped)"}`;
      });
      const answered = answers.filter((one) => one.status === "answered").length;
      const text = [...(call.heading !== undefined ? [call.heading] : []), `User answered ${answered} of ${subjects.length} questions:`, ...lines].join("\n");
      return { content: [{ type: "text", text }], details };
    }
  }
}
