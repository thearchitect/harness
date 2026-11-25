// The app takes every color from the theme (plan 10.2): no color literals in its sources besides
// the generated first-paint theme.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "packages", "app", "src");
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|["'](?:red|green|blue|orange|gray|grey|white|black|yellow|purple|pink|cyan|magenta)["']/;

test("no color literals in the app's sources", () => {
  const found: string[] = [];
  for (const entry of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && entry.name !== "fallback.generated.ts") {
      const path = join(entry.parentPath, entry.name);
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (LITERAL.test(line)) {
            found.push(`${path.slice(ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
          } else {
            // no color here
          }
        });
    } else {
      // not a source file
    }
  }
  assert.deepEqual(found, []);
});
