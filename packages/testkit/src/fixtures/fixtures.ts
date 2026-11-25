// Shared fixtures for galleries and tests: every interaction in its variants, tabs with every glyph,
// a session's items with tasks and subagents, long lines, empty states. Plain data (isomorphic):
// the TUI gallery draws them with TUI components, the app's gallery with its own.

import type { InteractionRequest } from "#protocol/interactions.ts";
import type { Item, NodeRow, Tab } from "#client/workbench/workbench.ts";

const at = 1_700_000_000_000;

export const INTERACTIONS: Record<string, InteractionRequest> = {
  "gate-write": {
    id: "g1",
    kind: "gate",
    openedAt: at,
    payload: { kind: "write", title: "Allow file change?", paths: ["src/order.ts"], detail: ["+ export function total(order: Order): number {", "+   return order.lines.reduce((sum, line) => sum + line.price, 0);", "+ }"] },
  },
  "gate-edit-subagent": {
    id: "g2",
    kind: "gate",
    openedAt: at,
    payload: { kind: "edit", title: "Allow file change?", by: "builder", paths: ["src/order.ts"], detail: ["- const tax = 0.2;", "+ const tax = TAX_RATE;"] },
  },
  "gate-refactor": {
    id: "g3",
    kind: "gate",
    openedAt: at,
    payload: { kind: "refactor", title: "Allow refactoring?", paths: ["src/a.ts", "src/b.ts", "src/c.ts"], detail: ["rename Order → PurchaseOrder (14 references)"] },
  },
  secret: { id: "s1", kind: "secret", openedAt: at, payload: { name: "GITHUB_TOKEN", description: "A GitHub token with repo scope (github.com/settings/tokens)", replaces: false } },
  "secret-replaces": { id: "s2", kind: "secret", openedAt: at, payload: { name: "OPENAI_API_KEY", description: "The OpenAI key", replaces: true } },
  "questions-one": {
    id: "q1",
    kind: "questions",
    openedAt: at,
    payload: {
      params: {
        question: "Which database?",
        context: "The service stores orders; both are available in the cluster.",
        options: [
          { title: "PostgreSQL", description: "relational, already used by billing" },
          { title: "SQLite", description: "one file, no server" },
        ],
        allowComment: true,
      },
    },
  },
  "questions-many": {
    id: "q2",
    kind: "questions",
    openedAt: at,
    payload: {
      params: {
        question: "The release",
        questions: [
          { question: "Targets?", options: [{ title: "Linux" }, { title: "macOS" }, { title: "Windows" }], allowMultiple: true, allowFreeform: false },
          { question: "Release now?", options: [{ title: "Yes" }, { title: "No" }], allowMultiple: false, allowFreeform: false },
        ],
      },
    },
  },
  "choice-limit": {
    id: "c1",
    kind: "choice",
    openedAt: at,
    payload: {
      title: "Claude waits for the weekly limit to reset at 05:00",
      options: [
        { id: "wait", title: "Wait" },
        { id: "continue", title: "Stop Claude, continue in harness" },
        { id: "stop", title: "Stop Claude and the run" },
      ],
    },
  },
  "pi-select": { id: "p1", kind: "pi-dialog", openedAt: at, payload: { method: "select", title: "Pick a profile", options: ["default", "fast", "careful"] } },
  "pi-confirm": { id: "p2", kind: "pi-dialog", openedAt: at, payload: { method: "confirm", title: "Delete the cache?", message: "12 MB in ~/.cache/x" } },
  "pi-input": { id: "p3", kind: "pi-dialog", openedAt: at, payload: { method: "input", title: "Branch name", placeholder: "feature/…" } },
};

function summary(status: "idle" | "running" | "waiting" | "error", extra: Partial<Tab> = {}): Tab {
  return {
    node: "laptop",
    sessionId: `s-${status}`,
    cwd: "/home/u/project",
    agent: undefined,
    glyph: " ",
    title: "project",
    mode: "plan",
    unavailable: undefined,
    index: 0,
    draft: false,
    ...extra,
  };
}

export const TABS: Tab[] = [
  summary("running", { glyph: "●", title: "harness", mode: "build" }),
  summary("waiting", { glyph: "◆", title: "infra", node: "hub", mode: "plan" }),
  summary("idle", { glyph: "✓", title: "api", node: "work", mode: "simple" }),
  summary("error", { glyph: "✗", title: "docs", node: "work" }),
  summary("idle", { glyph: "⊘", title: "offline-box", node: "nas", unavailable: "node nas is offline" }),
  summary("idle", { glyph: " ", title: "a very long session name that will not fit into the strip at all" }),
];

/** The nodes block: this window's own node, one with a session waiting, one offline. */
export const NODES: NodeRow[] = [
  { name: "laptop", label: "inprocess", glyph: "●" },
  { name: "hub", label: "hub", glyph: "◆" },
  { name: "work", label: "work", glyph: "⊘" },
];

export const ITEMS: Item[] = [
  { kind: "session", id: "session", label: "harness", detail: "BUILD", glyph: "●", depth: 0 },
  { kind: "task", id: "t1", label: "npm run dev", detail: "12m", glyph: "●", depth: 0 },
  { kind: "task", id: "t2", label: "npm test", detail: "exit 0", glyph: "✓", depth: 0 },
  { kind: "task", id: "t3", label: "cargo build --release", detail: "exit 101", glyph: "✗", depth: 0 },
  { kind: "subagent", id: "a1b2", label: "builder a1b2", detail: "waiting", glyph: "◆", depth: 0 },
  { kind: "subagent", id: "c3d4", label: "explorer c3d4", detail: "running", glyph: "●", depth: 1 },
];
