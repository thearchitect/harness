// Interactions in the editor's place (plan A25): the gate, a secret, questions, a choice, a file to
// look at, a pi dialog. The transcript stays above; focus stays in the block; the first answer of
// any client wins.

import { useState } from "react";
import { Image, TextInput, View } from "react-native";
import type { InteractionRequest } from "#protocol/interactions.ts";
import { AskUser } from "./AskUser.tsx";
import { Login } from "./Login.tsx";
import { secretValueProblem } from "#protocol/interactions.ts";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { Button, Dialog, Frame, T } from "./primitives.tsx";
import { interactionTitle } from "#client/workbench/dialogs.ts";

type Answer = (value: unknown) => void;

function Field(props: { value: string; onChange: (text: string) => void; label: string; secure?: boolean; multiline?: boolean; onSubmit?: () => void; placeholder?: string }) {
  const theme = useTheme();
  return (
    <TextInput
      accessibilityLabel={props.label}
      autoFocus
      value={props.value}
      onChangeText={props.onChange}
      secureTextEntry={props.secure}
      multiline={props.multiline}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.dim}
      onSubmitEditing={props.onSubmit}
      style={[fontOf(theme.chat), { color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 2, padding: 4, minHeight: props.multiline === true ? 60 : undefined }]}
    />
  );
}

function Gate({ request, answer }: { request: Extract<InteractionRequest, { kind: "gate" }>; answer: Answer }) {
  const [comment, setComment] = useState<"allow" | "reject" | undefined>(undefined);
  const [text, setText] = useState("");
  const payload = request.payload;
  return (
    <Frame title={`${payload.title}${payload.by !== undefined ? ` — subagent ${payload.by}` : ""}`} tone="warning">
      <T color="muted">{payload.paths.join("\n")}</T>
      <View style={{ maxHeight: 280 }}>
        {payload.detail.map((line, index) => (
          <T key={index} zone="chat" color={line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext"} selectable>
            {line}
          </T>
        ))}
      </View>
      {comment !== undefined ? (
        <View style={{ gap: 4 }}>
          <Field label="Comment" value={text} onChange={setText} multiline />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label={comment === "allow" ? "Allow with this comment" : "Reject with this comment"} tone={comment === "allow" ? "success" : "error"} onPress={() => answer({ action: comment, comment: text })} />
            <Button label="Back" onPress={() => setComment(undefined)} />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <Button label="Allow" tone="success" onPress={() => answer({ action: "allow" })} />
          <Button label="Allow with comment" onPress={() => setComment("allow")} />
          <Button label="Reject with comment" tone="error" onPress={() => setComment("reject")} />
          <Button label="Stop" tone="error" onPress={() => answer({ action: "stop" })} />
        </View>
      )}
    </Frame>
  );
}

function Secret({ request, answer }: { request: Extract<InteractionRequest, { kind: "secret" }>; answer: Answer }) {
  const [value, setValue] = useState("");
  const problem = value === "" ? undefined : secretValueProblem(value);
  return (
    <Frame title={`Secret ${request.payload.name}${request.payload.replaces ? " (replaces the one held)" : ""}`} tone="accent">
      <T color="muted">{request.payload.description}</T>
      <Field label="Secret value" value={value} onChange={setValue} secure onSubmit={() => (problem === undefined && value !== "" ? answer({ value }) : undefined)} />
      {problem !== undefined ? <T color="warning">{problem}</T> : null}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Button label="Save" tone="success" disabled={value === "" || problem !== undefined} onPress={() => answer({ value })} />
        <Button label="Cancel" onPress={() => answer({ cancelled: true })} />
      </View>
    </Frame>
  );
}

function Choice({ request, answer }: { request: Extract<InteractionRequest, { kind: "choice" }>; answer: Answer }) {
  return (
    <Frame title={request.payload.title} tone="warning">
      {request.payload.message !== undefined ? <T color="muted" selectable>{request.payload.message}</T> : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {request.payload.options.map((option) => (
          <Button key={option.id} label={option.title} onPress={() => answer({ id: option.id })} />
        ))}
      </View>
    </Frame>
  );
}

function Display({ request, answer }: { request: Extract<InteractionRequest, { kind: "display" }>; answer: Answer }) {
  const payload = request.payload;
  return (
    <Frame title={payload.path}>
      <View style={{ maxHeight: 400 }}>
        {payload.kind === "image" ? (
          <Image accessibilityLabel={payload.path} source={{ uri: payload.content }} style={{ width: "100%", height: 360 }} resizeMode="contain" />
        ) : (
          <T zone="chat" selectable>
            {payload.content}
          </T>
        )}
      </View>
      <Button label="Done" onPress={() => answer({ done: true })} />
    </Frame>
  );
}

function PiDialog({ request, answer }: { request: Extract<InteractionRequest, { kind: "pi-dialog" }>; answer: Answer }) {
  const payload = request.payload;
  const [text, setText] = useState(payload.method === "editor" ? (payload.prefill ?? "") : "");
  switch (payload.method) {
    case "select":
      return (
        <Frame title={payload.title} tone="accent">
          {payload.options.map((option) => (
            <Button key={option} label={option} onPress={() => answer({ value: option })} />
          ))}
          <Button label="Cancel" onPress={() => answer({ cancelled: true })} />
        </Frame>
      );
    case "confirm":
      return (
        <Frame title={payload.title} tone="accent">
          <T color="muted">{payload.message}</T>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label="Yes" tone="success" onPress={() => answer({ confirmed: true })} />
            <Button label="No" onPress={() => answer({ confirmed: false })} />
          </View>
        </Frame>
      );
    case "input":
    case "editor":
      return (
        <Frame title={payload.title} tone="accent">
          <Field label={payload.title} value={text} onChange={setText} multiline={payload.method === "editor"} placeholder={payload.method === "input" ? payload.placeholder : undefined} onSubmit={() => answer({ value: text })} />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label="OK" tone="success" onPress={() => answer({ value: text })} />
            <Button label="Cancel" onPress={() => answer({ cancelled: true })} />
          </View>
        </Frame>
      );
    default:
      throw new Error(`unknown pi dialog: ${JSON.stringify(payload satisfies never)}`);
  }
}

export function InteractionBlock({ request, from, answer, notify }: { request: InteractionRequest; from: string | undefined; answer: Answer; notify?: (message: string) => void }) {
  const body = (() => {
    switch (request.kind) {
      case "gate":
        return <Gate request={request} answer={answer} />;
      case "secret":
        return <Secret request={request} answer={answer} />;
      case "questions":
        return <AskUser request={request} answer={answer} />;
      case "choice":
        return <Choice request={request} answer={answer} />;
      case "display":
        return <Display request={request} answer={answer} />;
      case "pi-dialog":
        return <PiDialog request={request} answer={answer} />;
      case "login":
        return <Login request={request} answer={answer} notify={notify ?? (() => undefined)} />;
      default:
        throw new Error(`unknown interaction: ${JSON.stringify(request satisfies never)}`);
    }
  })();
  // the one frame of dialogs, its title saying what is asked and who asks
  return (
    <View accessibilityRole="none" accessibilityLabel={`interaction ${request.kind}`}>
      <Dialog title={interactionTitle(request, from !== undefined && !(request.kind === "gate" && request.payload.by === from) ? from : undefined)}>{body}</Dialog>
    </View>
  );
}
