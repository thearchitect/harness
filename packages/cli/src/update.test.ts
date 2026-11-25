/**
 * Tests of the bundle's update (update.ts): the GitHub contract of the check
 * (against a fake fetch), the pin changes read from CI's commits, and which
 * profile element holds the running bundle.
 *   node --test update.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkUpdates, pinChanges, profileElement } from "./update.ts";

const API = "https://api.github.com/repos/thearchitect/harness";

/** A commit as the GitHub API lists it. */
function commit(message: string, date: string): unknown {
  return { commit: { message, committer: { date } } };
}

/** fetch answering from a table of endpoint → response, recording what was asked. */
function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    asked.push(url.slice(API.length + 1));
    const route = routes[url.slice(API.length + 1)];
    if (route === undefined) {
      throw new TypeError("fetch failed");
    } else {
      return route();
    }
  }) as typeof fetch;
  return { fetch: fetchImpl, asked };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): (() => Response) =>
  () => new Response(JSON.stringify(body), { status, headers });

describe("checkUpdates", () => {
  test("new commits: their number, the latest's date and the pin changes, in one request", async () => {
    const { fetch, asked } = fakeFetch({
      "compare/f81c492...master": json({
        ahead_by: 2,
        commits: [
          commit("Update bundle pins\n\n@earendil-works/pi-coding-agent 1.5.2 -> 1.6.0", "2026-11-20T10:00:00Z"),
          commit("Simple mode", "2026-11-20T12:00:00Z"),
        ],
      }),
    });
    assert.deepEqual(await checkUpdates("f81c492", fetch), {
      kind: "available",
      count: 2,
      latest: new Date("2026-11-20T12:00:00Z"),
      changes: [{ component: "@earendil-works/pi-coding-agent", from: "1.5.2", to: "1.6.0" }],
    });
    assert.deepEqual(asked, ["compare/f81c492...master"]);
  });

  test("more commits than GitHub lists: the latest's date comes from master", async () => {
    const { fetch, asked } = fakeFetch({
      "compare/f81c492...master": json({ ahead_by: 300, commits: [commit("first", "2026-01-01T00:00:00Z")] }),
      "commits/master": json(commit("latest", "2026-11-20T12:00:00Z")),
    });
    const state = await checkUpdates("f81c492", fetch);
    assert.equal(state.kind === "available" && state.latest.toISOString(), "2026-11-20T12:00:00.000Z");
    assert.deepEqual(asked, ["compare/f81c492...master", "commits/master"]);
  });

  test("no new commits: up to date", async () => {
    const { fetch } = fakeFetch({ "compare/f81c492...master": json({ ahead_by: 0, commits: [] }) });
    assert.deepEqual(await checkUpdates("f81c492", fetch), { kind: "current" });
  });

  test("a dev or dirty build is not checked", async () => {
    const { fetch, asked } = fakeFetch({});
    assert.deepEqual(await checkUpdates("dev", fetch), { kind: "dev" });
    assert.deepEqual(await checkUpdates("f81c492-dirty", fetch), { kind: "dev" });
    assert.deepEqual(asked, []);
  });

  test("failures say why", async () => {
    const cases: [Record<string, () => Response>, string][] = [
      [{ "compare/f81c492...master": json({}, 403, { "x-ratelimit-remaining": "0" }) }, "GitHub rate limit"],
      [{ "compare/f81c492...master": json({}, 404) }, "revision not found on GitHub"],
      [{ "compare/f81c492...master": json({}, 502) }, "HTTP 502"],
      [{ "compare/f81c492...master": json({ message: "?" }) }, "unexpected compare response"],
      [{}, "fetch failed"],
    ];
    for (const [routes, reason] of cases) {
      assert.deepEqual(await checkUpdates("f81c492", fakeFetch(routes).fetch), { kind: "failed", reason });
    }
  });
});

describe("pinChanges", () => {
  test("each component from its first old version to its last new one, by name", () => {
    assert.deepEqual(
      pinChanges([
        "Update bundle pins\n\n@cortexkit/pi-magic-context 0.49.62 -> 0.49.64\n@playwright/mcp 0.0.85 -> 0.0.86",
        "Simple mode\n\nsome prose -> not a pin",
        "Update bundle pins\n\n@cortexkit/pi-magic-context 0.49.64 -> 0.49.67\nnixpkgs 64c08a7d1e2f -> 9f1e2d3c4b5a",
      ]),
      [
        { component: "@cortexkit/pi-magic-context", from: "0.49.62", to: "0.49.67" },
        { component: "@playwright/mcp", from: "0.0.85", to: "0.0.86" },
        { component: "nixpkgs", from: "64c08a7d1e2f", to: "9f1e2d3c4b5a" },
      ],
    );
  });

  test("only CI's pin commits count, and a component back at its old version did not change", () => {
    assert.deepEqual(
      pinChanges([
        "Bump by hand\n\nyaml 2.9.1 -> 2.9.2",
        "Update bundle pins\n\nzod 4.6.7 -> 4.6.8",
        "Update bundle pins\n\nzod 4.6.8 -> 4.6.7",
      ]),
      [],
    );
  });
});

describe("profileElement", () => {
  test("the element whose bundle holds the running manifest; none for a system install", async () => {
    const root = mkdtempSync(join(tmpdir(), "update-test-"));
    const manifest = join(root, "manifest.json");
    writeFileSync(manifest, "{}");
    for (const [bundle, target] of [["ours", manifest], ["other", join(root, "other.json")]] as const) {
      mkdirSync(join(root, bundle, "share", "harness"), { recursive: true });
      writeFileSync(join(root, "other.json"), "{}");
      symlinkSync(target, join(root, bundle, "share", "harness", "manifest.json"));
    }
    const list = (paths: Record<string, string[]>): string =>
      JSON.stringify({ version: 3, elements: Object.fromEntries(Object.entries(paths).map(([name, storePaths]) => [name, { storePaths }])) });

    assert.equal(
      await profileElement(list({ ripgrep: [join(root, "missing")], harness: [join(root, "ours")] }), manifest),
      "harness",
    );
    assert.equal(await profileElement(list({ harness: [join(root, "other")] }), manifest), undefined);
    assert.equal(await profileElement(JSON.stringify({ version: 3, elements: {} }), manifest), undefined);
    rmSync(root, { recursive: true, force: true });
  });
});
