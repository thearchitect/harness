#!/usr/bin/env bun
// methodology.yaml → SKILL.md, next to this file. Deterministic: rerun after
// editing the yaml and commit both.
//
//   bun experiments/methodology/build.ts

type Node = { title: string; note?: string; items?: Node[] };
type Methodology = { methodology: Node[] };

const DESCRIPTION =
  "Software engineering methodology: good sense over process, subconscious understandability, " +
  "simplicity and minimalism, SRP, explicitness, strongest contracts, dependency hygiene; general and " +
  "application architecture, code style, technical debt, investigation, docs, glossary. Load when designing " +
  "a system or judging an architectural or code-structure decision.";

const dir = new URL(".", import.meta.url);
const source = Bun.YAML.parse(await Bun.file(new URL("methodology.yaml", dir)).text()) as Methodology;

/** A note is omitted when it only marks unwritten content. */
function noteOf(node: Node): string | undefined {
  if (node.note === undefined || node.note.trim() === "TODO") {
    return undefined;
  } else {
    return node.note.trim();
  }
}

/** Heading levels for the two top tiers; deeper nodes are nested list items. */
function render(node: Node, depth: number, out: string[]): void {
  const note = noteOf(node);
  if (depth === 0) {
    out.push(`## ${node.title}`, "");
    if (note !== undefined) out.push(note, "");
  } else if (depth === 1) {
    out.push(`### ${node.title}`, "");
    if (note !== undefined) out.push(note, "");
  } else {
    const indent = "  ".repeat(depth - 2);
    if (note === undefined) {
      out.push(`${indent}- ${node.title}`);
    } else if (!note.includes("\n")) {
      out.push(`${indent}- ${node.title} — ${note}`);
    } else {
      out.push(`${indent}- ${node.title}`);
      for (const line of note.split("\n")) out.push(`${indent}  ${line}`);
    }
  }
  for (const child of node.items ?? []) render(child, depth + 1, out);
  if (depth <= 1 && (node.items?.length ?? 0) > 0) out.push("");
}

const lines: string[] = [
  "---",
  "name: methodology",
  `description: ${DESCRIPTION}`,
  "---",
  "",
  "# Methodology",
  "",
];
for (const section of source.methodology) render(section, 0, lines);

const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
await Bun.write(new URL("SKILL.md", dir), markdown);
console.log(`SKILL.md: ${markdown.length} bytes`);
