// The documents (plan 13.6): the protocol reference matches its generator; every link and anchor
// resolves (pi's documents are those of the bundled pi); no paragraph retells pi's documents;
// pi-mapping.md translates every pi path and command pi's documents use; the prompt's paths exist;
// shipped text is English.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { referencePages } from "#protocol/reference.ts";
import { REFERENCE_DIR } from "#testkit/docs/write-reference.ts";
import { documentationPaths } from "#extension/core/prompt.ts";

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");
const PI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

function files(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** GitHub's heading anchors. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(path: string): Set<string> {
  const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1] ?? "")));
}

/** A link of the bundle layout (docs/../pi/<package>/…) in the checkout: node_modules/@earendil-works/pi-<package>/…. */
function onDisk(path: string): string {
  const pi = join(ROOT, "pi");
  return path.startsWith(`${pi}/`) ? join(ROOT, "node_modules", "@earendil-works", `pi-${relative(pi, path)}`) : path;
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

test("the protocol reference is what its generator writes", () => {
  for (const [file, text] of Object.entries(referencePages())) {
    assert.equal(readFileSync(join(REFERENCE_DIR, file), "utf8"), text, `docs/protocol/reference/${file}: run node packages/testkit/src/docs/write-reference.ts`);
  }
});

test("every link and anchor of the documents resolves", () => {
  const broken: string[] = [];
  for (const file of files(DOCS, ".md")) {
    for (const match of withoutCode(readFileSync(file, "utf8")).matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1] ?? "";
      if (/^[a-z]+:/.test(link)) {
        continue; // a web address
      } else {
        const [path, anchor] = link.split("#") as [string, string | undefined];
        const target = path === "" ? file : onDisk(resolve(dirname(file), path));
        if (!existsSync(target)) {
          broken.push(`${relative(ROOT, file)}: ${link} (no ${relative(ROOT, target)})`);
        } else if (anchor !== undefined && statSync(target).isFile() && !anchors(target).has(anchor)) {
          broken.push(`${relative(ROOT, file)}: ${link} (no heading #${anchor})`);
        } else {
          // resolves
        }
      }
    }
  }
  assert.deepEqual(broken, []);
});

test("no paragraph retells pi's documents (12 words in a row)", () => {
  const words = (text: string): string[] => withoutCode(text).toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const shingles = new Set<string>();
  for (const file of [join(PI, "README.md"), ...files(join(PI, "docs"), ".md")]) {
    const list = words(readFileSync(file, "utf8"));
    for (let index = 0; index + 12 <= list.length; index += 1) {
      shingles.add(list.slice(index, index + 12).join(" "));
    }
  }
  const retold: string[] = [];
  for (const file of files(DOCS, ".md").filter((path) => !path.startsWith(REFERENCE_DIR))) {
    const list = words(readFileSync(file, "utf8"));
    for (let index = 0; index + 12 <= list.length; index += 1) {
      const shingle = list.slice(index, index + 12).join(" ");
      if (shingles.has(shingle)) {
        retold.push(`${relative(ROOT, file)}: "${shingle}"`);
        break;
      } else {
        // its own words
      }
    }
  }
  assert.deepEqual(retold, []);
});

test("pi-mapping.md translates every pi path and command of pi's documents", () => {
  const mapping = readFileSync(join(DOCS, "pi-mapping.md"), "utf8");
  const piText = [join(PI, "README.md"), ...files(join(PI, "docs"), ".md")].map((file) => readFileSync(file, "utf8")).join("\n");
  const paths = new Set([...piText.matchAll(/~\/\.pi\/agent(?:\/([A-Za-z0-9_.-]+))?/g)].map((match) => (match[1] !== undefined ? `~/.pi/agent/${match[1]}` : "~/.pi/agent")));
  const help = execFileSync(process.execPath, [join(PI, "dist", "bundle", "cli.js"), "--help"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(ROOT, ".test-reports", "pi-help") } });
  const subcommands = new Set([...help.matchAll(/^ {2}pi ([a-z]+) /gm)].map((match) => match[1] ?? ""));
  const code = [...piText.matchAll(/```[^\n]*\n([\s\S]*?)```/g), ...piText.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "").join("\n");
  const commands = new Set(
    [...code.matchAll(/(?:^|[\s;&|(])pi ((?:--?[a-z][a-z-]*)|[a-z][a-z-]*)/gm)].map((match) => match[1] ?? "").filter((token) => token.startsWith("-") || subcommands.has(token)),
  );
  const missing = [...[...paths].filter((path) => !mapping.includes(path)), ...[...commands].filter((command) => !mapping.includes(`pi ${command}`)).map((command) => `pi ${command}`)];
  assert.deepEqual(missing, []);
});

test("the prompt's documentation paths exist", () => {
  const paths = documentationPaths();
  assert.ok(existsSync(join(paths.docs, "index.md")));
  assert.ok(existsSync(join(paths.src, "packages")));
  assert.ok(existsSync(join(paths.piDocs, "extensions.md")));
});

test("shipped text is English (the one exception: operator phrases quoted in the prompt)", () => {
  const exception = "«запиши план»";
  const sources = files(join(ROOT, "packages"), "")
    .filter((path) => /\.(ts|yaml|md)$/.test(path) && !path.endsWith(".test.ts") && !path.includes("/testdata/") && !path.includes("/fixtures/"))
    .concat(files(DOCS, ".md"), [join(ROOT, "README.md")]);
  const found: string[] = [];
  for (const file of sources) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/[\u0400-\u04ff]/.test(line) && !line.includes(exception)) {
          found.push(`${relative(ROOT, file)}:${index + 1}`);
        } else {
          // English, or the exception
        }
      });
  }
  assert.deepEqual(found, []);
});
