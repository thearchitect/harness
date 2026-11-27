// Shared fixtures for galleries and tests: every interaction in its variants, tabs with every glyph,
// a session's items with tasks and subagents, long lines, empty states. Plain data (isomorphic):
// the TUI gallery draws them with TUI components, the app's gallery with its own.

import type { InteractionRequest } from "#protocol/interactions.ts";
import type { TaskDetails } from "#protocol/claude-transcript.ts";
import type { Item, HubRow, Tab } from "#client/workbench/workbench.ts";

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
  "login-method": {
    id: "l1",
    kind: "login",
    openedAt: at,
    payload: {
      title: "Log in to Anthropic",
      progress: [],
      prompt: { type: "select", message: "Select Anthropic login method:", options: [{ id: "browser", label: "Browser login (default)" }, { id: "manual", label: "Copy code login (headless)" }] },
    },
  },
  "login-link": {
    id: "l2",
    kind: "login",
    openedAt: at,
    payload: {
      title: "Log in to Anthropic",
      url: "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=cclTExtxrdsjWkTo_wBzREmM5MGnRkTu8PJXzNkQ-FU&code_challenge_method=S256&state=OQAGXVsKCKuXBv1eThmHZioj8UP4mskT1",
      instructions: "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
      progress: [],
      prompt: { type: "manual_code", message: "Paste the authorization code or the redirect URL:" },
    },
  },
  "login-device": {
    id: "l3",
    kind: "login",
    openedAt: at,
    payload: { title: "Log in to GitHub Copilot", deviceCode: { uri: "https://github.com/login/device", code: "ABCD-1234" }, progress: ["Waiting for authorization…"] },
  },
};

function summary(status: "idle" | "running" | "waiting" | "error", extra: Partial<Tab> = {}): Tab {
  return {
    hub: "laptop",
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
  summary("waiting", { glyph: "◆", title: "infra", hub: "hub", mode: "plan" }),
  summary("idle", { glyph: "✓", title: "api", hub: "work", mode: "simple" }),
  summary("error", { glyph: "✗", title: "docs", hub: "work" }),
  summary("idle", { glyph: "⊘", title: "offline-box", hub: "nas", unavailable: "hub nas is offline" }),
  summary("idle", { glyph: " ", title: "a very long session name that will not fit into the strip at all" }),
];

/** The hubs block: this window's own hub, one with a session waiting, one offline. */
export const HUBS: HubRow[] = [
  { name: "laptop", label: "inprocess", glyph: "●" },
  { name: "hub", label: "hub", glyph: "◆" },
  { name: "work", label: "work", glyph: "⊘" },
];

/** A subagent of Claude's inside its Task call: steps with a nested Task, a running one, a failure. */
export const CLAUDE_TASK: { args: { description: string; subagent_type: string }; result: { content: { type: string; text: string }[]; details: TaskDetails } } = {
  args: { description: "Check the tests and lint", subagent_type: "general-purpose" },
  result: {
    content: [{ type: "text", text: "Tests pass; lint found **one** warning." }],
    details: {
      running: false,
      steps: [
        { kind: "thinking", text: "Run the tests first, then lint." },
        { kind: "tool", id: "t1", name: "bash", args: { command: "npm test" }, result: "> test\n3 passing" },
        {
          kind: "tool",
          id: "t2",
          name: "Task",
          args: { description: "Lint" },
          result: "one warning",
          steps: [{ kind: "tool", id: "t3", name: "bash", args: { command: "npm run lint" }, result: "a.ts:3 unused variable", isError: true }],
        },
        { kind: "text", text: "Tests pass; lint found **one** warning." },
      ],
    },
  },
};

export const ITEMS: Item[] = [
  { kind: "session", id: "session", label: "harness", detail: "BUILD", glyph: "●", depth: 0 },
  { kind: "task", id: "t1", label: "npm run dev", detail: "12m", glyph: "●", depth: 0 },
  { kind: "task", id: "t2", label: "npm test", detail: "exit 0", glyph: "✓", depth: 0 },
  { kind: "task", id: "t3", label: "cargo build --release", detail: "exit 101", glyph: "✗", depth: 0 },
  { kind: "subagent", id: "a1b2", label: "builder a1b2", detail: "waiting", glyph: "◆", depth: 0 },
  { kind: "subagent", id: "c3d4", label: "explorer c3d4", detail: "running", glyph: "●", depth: 1 },
];
