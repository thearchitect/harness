// Where an agent finds its user's data and the bundle it runs from.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The user's harness directory: $HARNESS_HOME, else ~/.harness. */
export function dataDir(): string {
  const configured = process.env.HARNESS_HOME;
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".harness");
}

export type BundleLayout = {
  version: string;
  /** Entry points of the bundled pi packages, loaded after the harness extension. */
  extensionPaths: string[];
  skillPaths: string[];
};

/**
 * The bundle as its manifest describes it (a checkout without one runs the harness extension
 * alone), plus HARNESS_EXTRA_EXTENSIONS: colon-separated extension paths loaded after the bundled
 * ones (a development extension, the test stand's scripted model).
 */
export function bundleLayout(): BundleLayout {
  const extra = (process.env.HARNESS_EXTRA_EXTENSIONS ?? "").split(":").filter((path) => path !== "");
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined || path === "") {
    return { version: "dev", extensionPaths: extra, skillPaths: [] };
  } else {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { harness: string; piExtensions?: string[] };
    return { version: manifest.harness, extensionPaths: [...(manifest.piExtensions ?? []), ...extra], skillPaths: [] };
  }
}
