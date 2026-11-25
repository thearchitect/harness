// Writes the protocol reference (docs/protocol/reference/) from the protocol's schemas:
//   node packages/testkit/src/docs/write-reference.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { referencePages } from "#protocol/reference.ts";

export const REFERENCE_DIR = join(import.meta.dirname, "..", "..", "..", "..", "docs", "protocol", "reference");

if (import.meta.main) {
  mkdirSync(REFERENCE_DIR, { recursive: true });
  for (const [file, text] of Object.entries(referencePages())) {
    writeFileSync(join(REFERENCE_DIR, file), text);
  }
  process.stdout.write(`${REFERENCE_DIR}\n`);
}
