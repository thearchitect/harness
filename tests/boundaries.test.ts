// The package graph (plan, section 5): which package may import which, no cycles between packages,
// and the isomorphic packages (protocol, client) use no Node API, so the app bundles them as is.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const PACKAGES = ["protocol", "client", "node", "agent", "extension", "tui", "cli", "testkit"] as const;
type Package = (typeof PACKAGES)[number];

/** What each package may import (besides itself); testkit and tests may import anything. */
const ALLOWED: Record<Package, readonly Package[]> = {
  protocol: [],
  client: ["protocol"],
  extension: ["protocol"],
  agent: ["protocol", "client", "extension"],
  node: ["protocol"],
  tui: ["protocol", "client", "extension"],
  cli: ["protocol", "client", "node", "tui"],
  testkit: PACKAGES,
};

/** npm packages the isomorphic packages may use (pure JS: the app bundles them too). */
const ISOMORPHIC_NPM = ["typebox", "@xterm/headless"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes("/testdata/"));
}

function specifiers(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'`;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? match[2] ?? "");
}

test("packages import only what the graph allows; protocol and client use no Node API", () => {
  const problems: string[] = [];
  for (const pkg of PACKAGES) {
    for (const file of sources(join(root, "packages", pkg, "src"))) {
      const where = relative(root, file);
      for (const spec of specifiers(file)) {
        const target = /^#([a-z]+)\//.exec(spec)?.[1];
        if (target !== undefined) {
          if (target !== pkg && !(ALLOWED[pkg] as readonly string[]).includes(target)) {
            problems.push(`${where}: ${pkg} may not import ${target} (${spec})`);
          } else {
            // an allowed package
          }
        } else if (pkg === "protocol" || pkg === "client") {
          const npm = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (spec.startsWith("node:") || (!spec.startsWith(".") && !ISOMORPHIC_NPM.includes(npm ?? ""))) {
            problems.push(`${where}: isomorphic ${pkg} imports ${spec}`);
          } else {
            // relative, or an isomorphic npm package
          }
        } else {
          // Node packages may use Node and npm
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the allowed graph has no cycles", () => {
  const visiting = new Set<Package>();
  const done = new Set<Package>();
  const visit = (pkg: Package, path: Package[]): void => {
    if (done.has(pkg)) {
      return;
    } else if (visiting.has(pkg)) {
      assert.fail(`cycle: ${[...path, pkg].join(" -> ")}`);
    } else {
      visiting.add(pkg);
      for (const next of pkg === "testkit" ? [] : ALLOWED[pkg]) {
        visit(next, [...path, pkg]);
      }
      visiting.delete(pkg);
      done.add(pkg);
    }
  };
  for (const pkg of PACKAGES) {
    visit(pkg, []);
  }
});
