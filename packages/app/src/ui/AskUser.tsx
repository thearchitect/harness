// ask_user in the app, with pi-ask-user's flow (the TUI runs pi-ask-user itself): a question's
// options as rows — ↑/↓ or the pointer select, Enter (or a click) answers, Space ticks with several
// allowed —, "Type something." for an answer of one's own, the extra-context row when the call
// allows a comment, Esc to go back or dismiss. A batch goes question by question (its tabs jump,
// Skip leaves one unanswered) to a review that submits. The result is pi-ask-user's
// (client/src/ask-user.ts), so the model reads the same answer whichever client gave it.

import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Pressable, TextInput, View, type TextInputKeyPressEvent } from "react-native";
import { askCall, askResult, response, responseSummary, type AskCall, type AskQuestion, type AskResponse, type BatchAnswer } from "#client/ask-user.ts";
import type { InteractionRequest, QuestionsAnswer } from "#protocol/interactions.ts";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { HintLine } from "./EditorZone.tsx";
import { Button, Frame, ListRow, T } from "./primitives.tsx";
import { useListKeys } from "./web-events";

const COMMENT_ROW = "Add extra context after selection";

/** One question: its rows, then (when chosen) the answer of one's own or the comment. */
function QuestionPage(props: { question: AskQuestion; allowComment: boolean; onAnswer: (answer: AskResponse) => void; onBack: () => void; backLabel: string }) {
  const { question, allowComment } = props;
  const theme = useTheme();
  const [checked, setChecked] = useState<string[]>([]);
  const [commentOn, setCommentOn] = useState(false);
  const [mode, setMode] = useState<"select" | "freeform" | "comment">(question.options.length === 0 ? "freeform" : "select");
  const [pending, setPending] = useState<string[]>([]);
  const [text, setText] = useState("");
  const listRef = useRef<ComponentRef<typeof View>>(null);
  useListKeys(listRef, props.onBack);

  const choose = (selections: string[]): void => {
    if (allowComment && commentOn) {
      setPending(selections);
      setText("");
      setMode("comment");
    } else {
      const answer = response(selections, "", "");
      if (answer !== undefined) {
        props.onAnswer(answer);
      } else {
        // nothing chosen
      }
    }
  };
  const submitText = (): void => {
    const answer = mode === "comment" ? response(pending, "", text) : response([], text, "");
    if (answer !== undefined) {
      props.onAnswer(answer);
    } else {
      // empty: nothing to send
    }
  };
  const onKey = (event: TextInputKeyPressEvent): void => {
    const key = event.nativeEvent as { key: string; ctrlKey?: boolean; metaKey?: boolean };
    if (key.key === "Enter" && (key.ctrlKey === true || key.metaKey === true)) {
      event.preventDefault();
      submitText();
    } else if (key.key === "Escape") {
      event.preventDefault();
      if (question.options.length === 0) {
        props.onBack();
      } else {
        setMode("select");
      }
    } else {
      // typing
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <T bold selectable>
        {question.question}
      </T>
      {question.context !== undefined ? (
        <T color="muted" selectable>
          {question.context}
        </T>
      ) : null}
      {mode === "select" ? (
        <View ref={listRef} accessibilityRole="list" accessibilityLabel="options">
          {question.options.map((option, index) => {
            const ticked = checked.includes(option.title);
            return (
              <ListRow
                key={option.title}
                label={option.title}
                selected={ticked}
                onPress={() => (question.allowMultiple ? setChecked(ticked ? checked.filter((title) => title !== option.title) : [...checked, option.title]) : choose([option.title]))}
              >
                <T color="dim">{`${index + 1}. `}</T>
                {question.allowMultiple ? <T color={ticked ? "success" : "dim"}>{ticked ? "[✓] " : "[ ] "}</T> : null}
                <View style={{ flexShrink: 1 }}>
                  <T bold>{option.title}</T>
                  {option.description !== undefined ? <T color="muted">{option.description}</T> : null}
                </View>
              </ListRow>
            );
          })}
          {allowComment ? (
            <ListRow label={COMMENT_ROW} onPress={() => setCommentOn(!commentOn)}>
              <T color={commentOn ? "success" : "dim"}>{commentOn ? "[✓] " : "[ ] "}</T>
              <T bold>{COMMENT_ROW}</T>
            </ListRow>
          ) : null}
          {question.allowFreeform ? (
            <ListRow
              label="Type something."
              onPress={() => {
                setText("");
                setMode("freeform");
              }}
            >
              <T bold>Type something.</T>
              <T color="muted"> — Enter a custom response</T>
            </ListRow>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          <T color="accent" bold>
            {mode === "comment" ? `Selected: ${pending.join(", ")}` : "Custom response"}
          </T>
          <TextInput
            accessibilityLabel={mode === "comment" ? "Comment" : "Custom response"}
            autoFocus
            multiline
            value={text}
            onChangeText={setText}
            onKeyPress={onKey}
            placeholder={mode === "comment" ? "Add context for your selection" : "Type your answer"}
            placeholderTextColor={theme.colors.dim}
            style={[fontOf(theme.chat), { color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 2, padding: 4, minHeight: 60 }]}
          />
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 6 }}>
        {mode === "select" && question.allowMultiple ? <Button label="Submit" kbd="Enter" tone="success" disabled={checked.length === 0} onPress={() => choose(checked)} /> : null}
        {mode !== "select" ? <Button label={mode === "comment" ? "Submit" : "Send"} kbd="Ctrl+Enter" tone="success" disabled={mode === "freeform" && text.trim() === ""} onPress={submitText} /> : null}
        <Button label={mode !== "select" && question.options.length > 0 ? "Back" : props.backLabel} kbd="Esc" onPress={() => (mode !== "select" && question.options.length > 0 ? setMode("select") : props.onBack())} />
      </View>
      <HintLine
        hints={
          mode === "select"
            ? [
                { key: "↑↓", does: "navigate" },
                ...(question.allowMultiple ? [{ key: "space", does: "toggle" }] : []),
                { key: "enter", does: question.allowMultiple ? "toggle" : "select" },
                { key: "esc", does: props.backLabel.toLowerCase() },
              ]
            : [
                { key: "ctrl+enter", does: mode === "comment" ? "submit/skip" : "submit" },
                { key: "enter", does: "newline" },
                { key: "esc", does: question.options.length === 0 ? "cancel" : "back" },
              ]
        }
      />
    </View>
  );
}

function Batch({ call, done }: { call: Extract<AskCall, { kind: "batch" }>; done: (answers: BatchAnswer[] | undefined) => void }) {
  const [answers, setAnswers] = useState<(BatchAnswer | undefined)[]>(call.questions.map(() => undefined));
  const [page, setPage] = useState(0);
  const reviewing = page >= call.questions.length;
  const set = (index: number, answer: BatchAnswer): void => {
    setAnswers(answers.map((current, at) => (at === index ? answer : current)));
    setPage(index + 1);
  };
  const question = call.questions[page];
  return (
    <View style={{ gap: 8 }}>
      {call.heading !== undefined ? <T bold>{call.heading}</T> : null}
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {[...call.questions.map((_, index) => `${answers[index] !== undefined ? "✓" : "·"} ${index + 1}`), "Review"].map((label, index) => (
          <Pressable key={label} accessibilityRole="tab" accessibilityState={{ selected: index === page }} onPress={() => setPage(index)}>
            <T color={index === page ? "accent" : "muted"}>{label}</T>
          </Pressable>
        ))}
      </View>
      {question !== undefined && !reviewing ? (
        <View style={{ gap: 6 }}>
          <QuestionPage key={page} question={question} allowComment={call.allowComment} onAnswer={(answer) => set(page, { status: "answered", response: answer })} onBack={() => done(undefined)} backLabel="Cancel" />
          <View style={{ flexDirection: "row" }}>
            <Button label="Skip" onPress={() => set(page, { status: "skipped" })} />
          </View>
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          {call.questions.map((entry, index) => {
            const answer = answers[index];
            return (
              <ListRow key={entry.question} label={`Question ${index + 1}`} onPress={() => setPage(index)}>
                <T>{`${index + 1}. ${entry.question} → `}</T>
                <T color={answer?.status === "answered" ? "accent" : "warning"}>{answer?.status === "answered" ? responseSummary(answer.response) : "(skipped)"}</T>
              </ListRow>
            );
          })}
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label="Submit" kbd="Enter" tone="success" onPress={() => done(answers.map((answer) => answer ?? { status: "skipped" }))} />
            <Button label="Cancel" kbd="Esc" onPress={() => done(undefined)} />
          </View>
        </View>
      )}
    </View>
  );
}

export function AskUser({ request, answer }: { request: Extract<InteractionRequest, { kind: "questions" }>; answer: (value: QuestionsAnswer) => void }) {
  const parsed = useMemo((): { call: AskCall } | { error: string } => {
    try {
      return { call: askCall(request.payload.params) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [request.payload.params]);
  useEffect(() => {
    if ("error" in parsed) {
      answer({ error: parsed.error }); // malformed: the model reads why
    } else {
      // asked below
    }
  }, [parsed]);
  if ("error" in parsed) {
    return null;
  } else {
    const call = parsed.call;
    return (
      <Frame title="ask_user" tone="accent">
        {call.kind === "single" ? (
          <QuestionPage
            question={call.question}
            allowComment={call.allowComment}
            onAnswer={(response) => answer({ result: askResult(call, response) })}
            onBack={() => answer({ result: askResult(call, undefined) })}
            backLabel="Cancel"
          />
        ) : (
          <Batch call={call} done={(answers) => answer({ result: askResult(call, answers) })} />
        )}
      </Frame>
    );
  }
}
