// The transcript in the chat zone: user messages, answers (thinking, Markdown, tool rows with their
// results), the operator's commands, extensions' messages, harness's mode chips and finish banners,
// summaries; the answer in flight at the end. A virtualized list: older entries load at the top, the
// view follows new ones until the user scrolls up, then "Jump to latest" brings it back.

import { useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { FlatList, Image, Modal, Pressable, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { AgentModel, Message, ToolRun, TranscriptItem } from "#client/model/agent-model.ts";
import { MODE_TEXT, isRunMode } from "#protocol/modes.ts";
import { useTheme, type Token } from "../theme/theme.tsx";
import { Markdown } from "./Markdown.tsx";
import { Button, T } from "./primitives.tsx";

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string };

function blocksOf(content: unknown): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
  return blocksOf(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** The most telling argument of a tool call, for its row's title. */
export function argumentSummary(args: unknown): string {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const first = record.path ?? record.command ?? record.pattern ?? record.query ?? record.url ?? record.file ?? record.agent ?? record.code;
  return typeof first === "string" ? first.split("\n")[0]?.slice(0, 160) ?? "" : "";
}

type Row =
  | { kind: "item"; key: string; item: TranscriptItem }
  | { kind: "tool"; key: string; call: Block; result: Message | undefined; live: ToolRun | undefined }
  | { kind: "streaming"; key: string; message: Message };

/** Whether an item has a row of its own (an empty row would still take a gap). */
function drawn(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "message":
      return ["user", "assistant", "bashExecution", "custom"].includes(item.message.role);
    case "custom":
      return item.customType === "harness-finished";
    case "compaction":
    case "branch":
      return true;
    default:
      throw new Error(`unknown transcript item: ${JSON.stringify(item satisfies never)}`);
  }
}

/** The transcript as rows: each tool call with its result, tool results not on their own. */
function rowsOf(agent: AgentModel): Row[] {
  const results = new Map<string, Message>();
  for (const item of agent.items) {
    if (item.kind === "message" && item.message.role === "toolResult") {
      results.set(String(item.message.toolCallId), item.message);
    } else {
      // not a result
    }
  }
  const rows: Row[] = [];
  for (const item of agent.items) {
    if (!drawn(item)) {
      continue; // tool results are drawn in their call's row; other entries are not drawn
    } else if (item.kind === "message" && item.message.role === "assistant") {
      rows.push({ kind: "item", key: item.key, item });
      for (const call of blocksOf(item.message.content).filter((block) => block.type === "toolCall")) {
        rows.push({ kind: "tool", key: `${item.key}:${call.id}`, call, result: results.get(String(call.id)), live: agent.tools.get(String(call.id)) });
      }
    } else {
      rows.push({ kind: "item", key: item.key, item });
    }
  }
  if (agent.streaming !== undefined) {
    rows.push({ kind: "streaming", key: "streaming", message: agent.streaming });
  } else {
    // nothing in flight
  }
  return rows;
}

/** What send_file's result offers (extension/tools/send_file.ts). */
type SentFile = { path: string; name: string; size: number; comment: string };

function sentFileOf(result: Message | undefined): SentFile | undefined {
  const details = result?.details as Partial<SentFile> | undefined;
  return result?.isError !== true && typeof details?.path === "string" && typeof details.name === "string" ? (details as SentFile) : undefined;
}

/** A file the agent sent: its comment and a button that brings it to this device. */
function SentFileRow({ file, onDownload }: { file: SentFile; onDownload: (path: string, name: string) => void }) {
  const theme = useTheme();
  return (
    <View style={{ backgroundColor: theme.colors.toolSuccessBg, paddingHorizontal: 8, paddingVertical: 4, gap: 4 }}>
      <T zone="chat" selectable>
        {file.comment}
      </T>
      <View style={{ flexDirection: "row" }}>
        <Button label={`Download ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`} onPress={() => onDownload(file.path, file.name)} />
      </View>
    </View>
  );
}

function ToolRow({ call, result, live, expanded, onDownload }: { call: Block; result: Message | undefined; live: ToolRun | undefined; expanded: boolean; onDownload: (path: string, name: string) => void }) {
  const theme = useTheme();
  const sent = call.name === "send_file" ? sentFileOf(result) : undefined;
  if (sent !== undefined) {
    return <SentFileRow file={sent} onDownload={onDownload} />;
  } else {
    // every other tool: its title, arguments and output
  }
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const shown = open ?? expanded;
  const done = result !== undefined;
  const failed = result?.isError === true;
  const background: Token = !done ? "toolPendingBg" : failed ? "toolErrorBg" : "toolSuccessBg";
  const output = done ? blocksOf(result.content) : blocksOf((live?.partialResult as { content?: unknown } | undefined)?.content);
  const text = output
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  const lines = text.split("\n");
  const preview = shown ? text : lines.slice(-6).join("\n");
  return (
    <View style={{ backgroundColor: theme.colors[background], paddingHorizontal: 8, paddingVertical: 3 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${call.name ?? "tool"} ${argumentSummary(call.arguments)}`} accessibilityState={{ expanded: shown }} onPress={() => setOpen(!shown)}>
        <T zone="chat" color="toolTitle" lines={shown ? undefined : 1}>
          <T zone="chat" bold>
            {call.name}
          </T>{" "}
          {argumentSummary(call.arguments)}
        </T>
      </Pressable>
      {editsOf(call) !== undefined ? (
        <DiffView edits={editsOf(call) ?? []} />
      ) : shown ? (
        <T zone="chat" color="dim" selectable>
          {JSON.stringify(call.arguments, null, 2)}
        </T>
      ) : null}
      {text !== "" ? (
        <T zone="chat" color="toolOutput" selectable>
          {!shown && lines.length > 6 ? `… ${lines.length - 6} more lines\n` : ""}
          {preview}
        </T>
      ) : null}
      {shown && text !== "" ? (
        <View style={{ flexDirection: "row" }}>
          <Button label="Copy the output" onPress={() => void Clipboard.setStringAsync(text)} />
        </View>
      ) : null}
      {output
        .filter((block) => block.type === "image" && block.data !== undefined)
        .map((block, index) => (
          <ZoomableImage key={index} uri={`data:${block.mimeType};base64,${block.data}`} />
        ))}
    </View>
  );
}

/** An image of a result: small in the row; a press shows it as large as the window. */
function ZoomableImage({ uri }: { uri: string }) {
  const theme = useTheme();
  const [zoomed, setZoomed] = useState(false);
  return (
    <>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel="tool image (press to enlarge)" onPress={() => setZoomed(true)}>
        <Image source={{ uri }} style={{ width: 320, height: 200 }} resizeMode="contain" />
      </Pressable>
      <Modal visible={zoomed} transparent onRequestClose={() => setZoomed(false)}>
        <Pressable accessibilityLabel="Close the image" onPress={() => setZoomed(false)} style={{ flex: 1, backgroundColor: theme.colors.pageBg, padding: 16 }}>
          <Image accessibilityLabel="enlarged image" source={{ uri }} style={{ flex: 1 }} resizeMode="contain" />
        </Pressable>
      </Modal>
    </>
  );
}

type Edit = { path: string; oldText: string; newText: string };

/** The replacements of an `edit` call (one or several), or a `write`'s whole content as added lines. */
function editsOf(call: Block): Edit[] | undefined {
  const args = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as { path?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown; content?: unknown };
  const path = typeof args.path === "string" ? args.path : "";
  if (call.name === "edit" && Array.isArray(args.edits)) {
    return (args.edits as { oldText?: unknown; newText?: unknown }[]).map((edit) => ({ path, oldText: String(edit.oldText ?? ""), newText: String(edit.newText ?? "") }));
  } else if (call.name === "edit" && typeof args.oldText === "string") {
    return [{ path, oldText: args.oldText, newText: String(args.newText ?? "") }];
  } else if (call.name === "write" && typeof args.content === "string") {
    return [{ path, oldText: "", newText: args.content }];
  } else {
    return undefined;
  }
}

const DIFF_LINES = 60;

/** Removed and added lines: one column, or side by side when the window is wide. */
function DiffView({ edits }: { edits: Edit[] }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const sideBySide = width >= 1200;
  const lines = (text: string, prefix: string): string[] => (text === "" ? [] : text.split("\n").map((line) => `${prefix} ${line}`));
  return (
    <View accessibilityLabel="diff" style={{ gap: 4, paddingVertical: 2 }}>
      {edits.map((edit, index) => {
        const removed = lines(edit.oldText, "-").slice(0, DIFF_LINES);
        const added = lines(edit.newText, "+").slice(0, DIFF_LINES);
        return sideBySide && removed.length > 0 ? (
          <View key={index} style={{ flexDirection: "row", gap: 8 }}>
            <T zone="chat" color="toolDiffRemoved" selectable style={{ flex: 1 }}>
              {removed.join("\n")}
            </T>
            <T zone="chat" color="toolDiffAdded" selectable style={{ flex: 1, borderLeftWidth: 1, borderColor: theme.colors.borderMuted, paddingLeft: 8 }}>
              {added.join("\n")}
            </T>
          </View>
        ) : (
          <View key={index}>
            {removed.length > 0 ? (
              <T zone="chat" color="toolDiffRemoved" selectable>
                {removed.join("\n")}
              </T>
            ) : null}
            <T zone="chat" color="toolDiffAdded" selectable>
              {added.join("\n")}
            </T>
          </View>
        );
      })}
    </View>
  );
}

function Assistant({ message }: { message: Message }) {
  const blocks = blocksOf(message.content);
  return (
    <View style={{ gap: 4 }}>
      {blocks.map((block, index) =>
        block.type === "thinking" && (block.thinking ?? "") !== "" ? (
          <T key={index} zone="chat" color="thinkingText" italic selectable>
            {block.thinking}
          </T>
        ) : block.type === "text" && (block.text ?? "") !== "" ? (
          <Markdown key={index} source={block.text ?? ""} />
        ) : null,
      )}
      {message.stopReason === "error" ? (
        <T zone="chat" color="error">
          {String(message.errorMessage ?? "the model failed")}
        </T>
      ) : message.stopReason === "aborted" ? (
        <T zone="chat" color="warning">
          stopped
        </T>
      ) : null}
    </View>
  );
}

function ItemView({ item }: { item: TranscriptItem }) {
  const theme = useTheme();
  switch (item.kind) {
    case "message": {
      const message = item.message;
      switch (message.role) {
        case "user":
          return (
            <View style={{ backgroundColor: theme.colors.userMessageBg, paddingHorizontal: 8, paddingVertical: 4 }}>
              <T zone="chat" color="userMessageText" selectable>
                {textOf(message.content)}
              </T>
            </View>
          );
        case "assistant":
          return <Assistant message={message} />;
        case "bashExecution": {
          const code = message.exitCode as number | undefined;
          const tone: Token = message.cancelled === true ? "toolPendingBg" : code === 0 ? "toolSuccessBg" : "toolErrorBg";
          return (
            <View style={{ backgroundColor: theme.colors[tone], paddingHorizontal: 8, paddingVertical: 3 }}>
              <T zone="chat" color="bashMode" bold>{`$ ${String(message.command)}`}</T>
              <T zone="chat" color="toolOutput" selectable>
                {String(message.output ?? "")}
              </T>
              {code !== undefined && code !== 0 ? <T zone="chat" color="error">{`exit ${code}`}</T> : null}
            </View>
          );
        }
        case "custom":
          return (
            <View style={{ backgroundColor: theme.colors.customMessageBg, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T zone="chat" color="customMessageLabel" bold>
                {String(message.customType ?? "message")}
              </T>
              <T zone="chat" color="customMessageText" selectable>
                {textOf(message.content)}
              </T>
            </View>
          );
        default:
          return null; // tool results: in their call's row; others are not drawn
      }
    }
    case "custom":
      return <CustomEntry type={item.customType} data={item.data} />;
    case "compaction":
      return <Summary title={`compacted${item.tokensBefore !== undefined ? ` (${item.tokensBefore} tokens before)` : ""}`} text={item.summary} />;
    case "branch":
      return <Summary title="branch summary" text={item.summary} />;
    default:
      throw new Error(`unknown transcript item: ${JSON.stringify(item satisfies never)}`);
  }
}

function Summary({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
      <T zone="chat" color="muted">{`≡ ${title}`}</T>
      {open ? (
        <T zone="chat" color="muted" selectable>
          {text}
        </T>
      ) : null}
    </Pressable>
  );
}

/** harness's entries: the mode of a run and its finish banner; other extensions' entries are not drawn. */
function CustomEntry({ type, data }: { type: string; data: unknown }) {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  if (type === "harness-finished" && isRunMode(record.mode)) {
    const seconds = typeof record.durationMs === "number" ? (record.durationMs / 1000).toFixed(1) : "?";
    const cost = typeof record.costUsd === "number" ? record.costUsd.toFixed(3) : "0.000";
    return (
      <T zone="chat" color={record.interrupted === true ? "warning" : "dim"}>
        {`${record.interrupted === true ? MODE_TEXT[record.mode].interrupted : MODE_TEXT[record.mode].finished}  ${String(record.model ?? "")} • ${String(record.effort ?? "")} / ${seconds}s / $${cost}`}
      </T>
    );
  } else {
    return null;
  }
}

export function Transcript({ agent, expanded, onLoadOlder, onDownload }: { agent: AgentModel; expanded: boolean; onLoadOlder: () => void; onDownload: (path: string, name: string) => void }) {
  const list = useRef<FlatList<Row>>(null);
  const [following, setFollowing] = useState(true);
  const rows = useMemo(() => rowsOf(agent), [agent, agent.items, agent.streaming, agent.tools.size]);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setFollowing(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
  };
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        accessibilityLabel="transcript"
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item: row }) =>
          row.kind === "tool" ? (
            <ToolRow call={row.call} result={row.result} live={row.live} expanded={expanded} onDownload={onDownload} />
          ) : row.kind === "streaming" ? (
            <Assistant message={row.message} />
          ) : (
            <ItemView item={row.item} />
          )
        }
        contentContainerStyle={{ gap: 8, padding: 8 }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => (following ? list.current?.scrollToEnd({ animated: false }) : undefined)}
        onStartReached={agent.cursor !== undefined ? onLoadOlder : undefined}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
      {!following ? (
        <View style={{ position: "absolute", right: 12, bottom: 8 }}>
          <Button
            label="Jump to latest"
            onPress={() => {
              setFollowing(true);
              list.current?.scrollToEnd({ animated: false });
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
