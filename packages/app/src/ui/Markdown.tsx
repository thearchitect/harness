// Markdown of answers in the chat zone: headings, lists, quotes, code blocks (with a copy button),
// inline code, bold, italic and links, colored by pi's md* tokens.

import * as Clipboard from "expo-clipboard";
import { Linking, Text, View } from "react-native";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { Button, T } from "./primitives.tsx";

type Block = { kind: "code"; lang: string; text: string } | { kind: "heading"; level: number; text: string } | { kind: "item"; marker: string; text: string } | { kind: "quote"; text: string } | { kind: "para"; text: string } | { kind: "rule" };

export function blocksOf(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      index += 1;
    } else {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const item = /^(\s*(?:[-*+]|\d+[.)]))\s+(.*)$/.exec(line);
      if (heading !== null) {
        blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      } else if (item !== null) {
        blocks.push({ kind: "item", marker: item[1] ?? "-", text: item[2] ?? "" });
      } else if (/^\s*>/.test(line)) {
        blocks.push({ kind: "quote", text: line.replace(/^\s*>\s?/, "") });
      } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        blocks.push({ kind: "rule" });
      } else if (line.trim() === "") {
        // a paragraph break
      } else {
        const previous = blocks.at(-1);
        if (previous?.kind === "para" && (lines[index - 1] ?? "").trim() !== "") {
          previous.text = `${previous.text}\n${line}`;
        } else {
          blocks.push({ kind: "para", text: line });
        }
      }
      index += 1;
    }
  }
  return blocks;
}

/** Inline markup: `code`, **bold**, *italic*, [text](url). */
function Inline({ text }: { text: string }) {
  const theme = useTheme();
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g);
  return (
    <>
      {parts.map((part, index) => {
        if (/^`[^`]+`$/.test(part)) {
          return (
            <Text key={index} style={{ color: theme.colors.mdCode }}>
              {part.slice(1, -1)}
            </Text>
          );
        } else if (/^\*\*[^*]+\*\*$/.test(part)) {
          return (
            <Text key={index} style={{ fontWeight: "bold" }}>
              {part.slice(2, -2)}
            </Text>
          );
        } else if (/^\*[^*\s][^*]*\*$/.test(part)) {
          return (
            <Text key={index} style={{ fontStyle: "italic" }}>
              {part.slice(1, -1)}
            </Text>
          );
        } else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
          return link !== null ? (
            <Text key={index} accessibilityRole="link" style={{ color: theme.colors.mdLink, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(link[2] ?? "")}>
              {link[1]}
            </Text>
          ) : (
            part
          );
        }
      })}
    </>
  );
}

export function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const theme = useTheme();
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.mdCodeBlockBorder, borderRadius: 2, backgroundColor: theme.colors.cardBg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 6 }}>
        <T zone="chat" color="dim">
          {lang ?? ""}
        </T>
        <Button label="Copy" onPress={() => void Clipboard.setStringAsync(text)} />
      </View>
      <T zone="chat" color="mdCodeBlock" selectable style={{ paddingHorizontal: 6, paddingBottom: 4 }}>
        {text}
      </T>
    </View>
  );
}

export function Markdown({ source }: { source: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4 }}>
      {blocksOf(source).map((block, index) => {
        switch (block.kind) {
          case "code":
            return <CodeBlock key={index} text={block.text} lang={block.lang} />;
          case "heading":
            return (
              <T key={index} zone="chat" color="mdHeading" bold selectable>
                <Inline text={block.text} />
              </T>
            );
          case "item":
            return (
              <T key={index} zone="chat" selectable>
                <Text style={{ color: theme.colors.mdListBullet }}>{`${block.marker} `}</Text>
                <Inline text={block.text} />
              </T>
            );
          case "quote":
            return (
              <View key={index} style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.mdQuoteBorder, paddingLeft: 6 }}>
                <T zone="chat" color="mdQuote" selectable>
                  <Inline text={block.text} />
                </T>
              </View>
            );
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: theme.colors.mdHr }} />;
          case "para":
            return (
              <Text key={index} selectable style={[fontOf(theme.chat), { color: theme.colors.text }]}>
                <Inline text={block.text} />
              </Text>
            );
          default:
            throw new Error(`unknown block: ${JSON.stringify(block satisfies never)}`);
        }
      })}
    </View>
  );
}
