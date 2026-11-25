// ask_user: the model asks the operator one question, or two to four independent ones together,
// with optional multiple-choice answers, through the `questions` interaction every client draws
// natively. A freeform answer and an extra comment are always offered (the harness rule: the
// operator can always say something the options do not).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { Question, QuestionAnswer } from "#protocol/interactions.ts";
import type { Interactions } from "../host.ts";

const OPTION = Type.Object({
  title: Type.String({ description: "Short title for this option" }),
  description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
});

const QUESTION = Type.Object({
  question: Type.String({ description: "One question in the batch" }),
  context: Type.Optional(Type.String({ description: "Relevant context to show with this question (summary of findings)" })),
  options: Type.Optional(Type.Array(OPTION, { description: "List of options for this question" })),
  allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
});

const PARAMETERS = Type.Object({
  question: Type.Optional(Type.String({ description: "The question to ask the user. With questions, it is only an optional heading for the batch; put every actual question inside questions." })),
  context: Type.Optional(Type.String({ description: "Relevant context to show before the question (summary of findings)" })),
  options: Type.Optional(Type.Array(OPTION, { description: "List of options for the user to choose from" })),
  allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
  questions: Type.Optional(Type.Array(QUESTION, { minItems: 2, maxItems: 4, description: "2-4 independent questions shown together, used instead of question" })),
});

type Params = Static<typeof PARAMETERS>;

/** The questions of a call: the batch, or the single question. */
export function questionsOf(params: Params): Question[] {
  const toQuestion = (q: { question: string; context?: string; options?: { title: string; description?: string }[]; allowMultiple?: boolean }): Question => ({
    question: q.question,
    context: q.context,
    options: q.options ?? [],
    allowMultiple: q.allowMultiple ?? false,
    allowFreeform: true,
  });
  if (params.questions !== undefined && params.questions.length > 0) {
    return params.questions.map(toQuestion);
  } else if (params.question !== undefined && params.question.trim() !== "") {
    return [toQuestion({ question: params.question, context: params.context, options: params.options, allowMultiple: params.allowMultiple })];
  } else {
    throw new Error("ask_user needs a question, or 2-4 questions");
  }
}

/** The answers as the model reads them. */
export function describeAnswers(questions: Question[], answers: QuestionAnswer[]): string {
  return questions
    .map((question, index) => {
      const answer = answers[index];
      const parts = [
        ...(answer?.selected ?? []),
        ...(answer?.freeform !== undefined && answer.freeform.trim() !== "" ? [`(own answer) ${answer.freeform.trim()}`] : []),
      ];
      const comment = answer?.comment !== undefined && answer.comment.trim() !== "" ? `\nComment: ${answer.comment.trim()}` : "";
      return `Q: ${question.question}\nA: ${parts.length > 0 ? parts.join("; ") : "(no answer)"}${comment}`;
    })
    .join("\n\n");
}

export function registerAskUser(pi: ExtensionAPI, interactions: Interactions): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask one focused question per call, or 2-4 independent questions together through questions. Before calling, gather context with tools and pass a short summary via the context field.",
    promptSnippet: "Ask the user one focused question (or 2-4 independent ones together) with optional multiple-choice answers to gather information interactively",
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(toolCallId, params, signal): Promise<{ content: { type: "text"; text: string }[]; details: { questions: Question[]; answers?: QuestionAnswer[]; cancelled?: boolean } }> {
      const questions = questionsOf(params);
      const answer = await interactions.ask("questions", { questions }, { signal, toolCallId });
      if (answer === undefined || "cancelled" in answer) {
        return { content: [{ type: "text", text: "The user dismissed the question without answering." }], details: { questions, cancelled: true } };
      } else {
        return { content: [{ type: "text", text: describeAnswers(questions, answer.answers) }], details: { questions, answers: answer.answers } };
      }
    },
  });
}
