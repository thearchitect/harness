/**
 * ask_secret (desktop profile only): the operator types a secret into a
 * masked dialog; the value never reaches the model. It is kept in memory for
 * the session (globalThis, so /reload keeps it; gone when pi exits), given to
 * every bash command of the session as an environment variable (the bash
 * wrapper in index.ts), and masked in every tool result. The model moves it
 * into cage itself when it must outlive the session, without reading it.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** What a secret value becomes in tool results: cage's mask, which cage refuses to store. */
export const SECRET_MASK = "****************";

/** Shorter values would mask ordinary text. */
export const SECRET_MIN_LENGTH = 4;

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Why a variable name cannot hold a secret, or undefined when it can. */
export function secretNameProblem(name: string): string | undefined {
  if (!SECRET_NAME.test(name)) {
    return `${name} is not a variable name: use A-Z, 0-9 and _, not starting with a digit`;
  } else if (name in process.env) {
    return `${name} is already set in pi's environment: choose another name`;
  } else {
    return undefined;
  }
}

/** Why the operator's value cannot be taken, or undefined when it can. */
export function secretValueProblem(value: string): string | undefined {
  if ([...value].length < SECRET_MIN_LENGTH) {
    return `at least ${SECRET_MIN_LENGTH} characters: shorter values cannot be masked safely`;
  } else {
    return undefined;
  }
}

/** A value with every secret replaced by the mask, and whether anything was replaced. */
export type Masked<T> = { value: T; changed: boolean };

type SessionStore = Map<string, Map<string, string>>;

const STORE_KEY = Symbol.for("harness.secrets");

/** Every session's secrets in this process; on globalThis so a /reload keeps them. */
function sessionStore(): SessionStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: SessionStore };
  const existing = holder[STORE_KEY];
  if (existing !== undefined) {
    return existing;
  } else {
    const created: SessionStore = new Map();
    holder[STORE_KEY] = created;
    return created;
  }
}

function maskDeep(value: unknown, secrets: string[]): Masked<unknown> {
  if (typeof value === "string") {
    const masked = secrets.reduce((text, secret) => text.replaceAll(secret, SECRET_MASK), value);
    return { value: masked, changed: masked !== value };
  } else if (Array.isArray(value)) {
    const items = value.map((item) => maskDeep(item, secrets));
    return { value: items.map((item) => item.value), changed: items.some((item) => item.changed) };
  } else if (value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.entries(value).map(([key, item]) => [key, maskDeep(item, secrets)] as const);
    return {
      value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])),
      changed: entries.some(([, item]) => item.changed),
    };
  } else {
    // numbers, booleans, null, undefined and non-plain objects carry no text
    return { value, changed: false };
  }
}

/** The secrets the operator gave, per session id. */
export const sessionSecrets = {
  set(sessionId: string, name: string, value: string): void {
    const store = sessionStore();
    const secrets = store.get(sessionId) ?? new Map<string, string>();
    secrets.set(name, value);
    store.set(sessionId, secrets);
  },

  has(sessionId: string, name: string): boolean {
    return sessionStore().get(sessionId)?.has(name) ?? false;
  },

  /** The variables a bash command of the session gets. */
  env(sessionId: string): Record<string, string> {
    return Object.fromEntries(sessionStore().get(sessionId) ?? []);
  },

  /** Every string inside value with the session's secrets masked, longest first. */
  mask<T>(sessionId: string, value: T): Masked<T> {
    const secrets = [...(sessionStore().get(sessionId)?.values() ?? [])].sort((a, b) => b.length - a.length);
    return maskDeep(value, secrets) as Masked<T>;
  },
};

/** A single-line input that never renders its value: one bullet per character. */
export class MaskedSecretInput implements Component, Focusable {
  private readonly input = new Input();
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  constructor() {
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.onEscape = () => this.onEscape?.();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const bullets = "•".repeat([...this.input.getValue()].length);
    return [truncateToWidth(`> ${bullets}${this.focused ? "▏" : ""}`, width)];
  }
}

/** The dialog: what to enter, where it goes, the masked input. */
class SecretDialog implements Component, Focusable {
  private readonly input = new MaskedSecretInput();
  private problem: string | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly name: string;
  private readonly description: string;
  private readonly replaces: boolean;

  constructor(tui: TUI, theme: Theme, name: string, description: string, replaces: boolean, done: (value: string | undefined) => void) {
    this.tui = tui;
    this.theme = theme;
    this.name = name;
    this.description = description;
    this.replaces = replaces;
    this.input.onSubmit = (value) => {
      const problem = secretValueProblem(value);
      if (problem === undefined) {
        done(value);
      } else {
        this.problem = problem;
        this.tui.requestRender();
      }
    };
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.problem = undefined;
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const title = ` secret for the agent: ${this.name} `;
    return [
      theme.fg("accent", "──") + theme.fg("dim", theme.bold(title)) + theme.fg("accent", "─".repeat(Math.max(0, width - title.length - 2))),
      ...wrapTextWithAnsi(this.description, inner).map((line) => ` ${line}`),
      ...wrapTextWithAnsi(
        theme.fg("dim", `Kept in memory for this session only; bash commands get it as $${this.name}, tool results show it masked.`),
        inner,
      ).map((line) => ` ${line}`),
      ...(this.replaces ? [` ${theme.fg("warning", `Replaces the value of $${this.name} given earlier.`)}`] : []),
      ...this.input.render(inner).map((line) => ` ${line}`),
      ...(this.problem !== undefined ? [` ${theme.fg("error", this.problem)}`] : []),
      ` ${theme.fg("dim", "Enter store · Esc cancel")}`,
      theme.fg("accent", "─".repeat(width)),
    ].map((line) => truncateToWidth(line, width));
  }
}

async function askOperator(ctx: ExtensionContext, name: string, description: string, replaces: boolean): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => new SecretDialog(tui, theme, name, description, replaces, done),
    { blocked: { kind: "auth", message: `secret ${name}` } },
  );
}

export function registerAskSecret(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_secret",
    label: "Ask secret",
    description: [
      "Ask the operator for a secret (token, password, API key) in a masked dialog.",
      "The value never reaches you: it is kept in memory for this session only (lost when pi exits),",
      "every bash command of the session gets it as the environment variable `name`,",
      `and tool results show it as ${SECRET_MASK}. Works in PLAN and BUILD: nothing is written to disk.`,
      "Call it only on the operator's explicit command.",
    ].join(" "),
    promptSnippet: "Get a secret from the operator into a bash environment variable without seeing it",
    promptGuidelines: [
      "Call ask_secret only when the operator explicitly tells you to request secrets, never on your own initiative. When a task needs a secret only the operator has (token, password, API key), name it in the plan (variable name, what it is, where to get it) and wait for the operator's command; never ask for its value in chat.",
      "Use a secret from ask_secret only as `$NAME` inside bash commands; never print it.",
      "When a secret from ask_secret must outlive the session, store it in cage in BUILD without reading it: printf '%s' \"$NAME\" | cage set -stdin <ref> NAME (the cage skill).",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "The environment variable for bash commands: A-Z, 0-9 and _, e.g. GITHUB_TOKEN" }),
      description: Type.String({ description: "What the operator should enter and where to get it" }),
    }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const nameProblem = secretNameProblem(params.name);
      if (ctx.mode !== "tui") {
        throw new Error(`ask_secret needs pi's TUI (this session runs in ${ctx.mode} mode): ask the operator to provide the secret another way`);
      } else if (nameProblem !== undefined) {
        throw new Error(nameProblem);
      } else if (params.description.trim() === "") {
        throw new Error("description is required: say what to enter and where to get it");
      } else {
        const sessionId = ctx.sessionManager.getSessionId();
        const value = await askOperator(ctx, params.name, params.description.trim(), sessionSecrets.has(sessionId, params.name));
        if (value === undefined) {
          throw new Error("The operator declined to enter the secret.");
        } else {
          sessionSecrets.set(sessionId, params.name, value);
          return {
            content: [{
              type: "text",
              text: `Stored as $${params.name} for bash commands of this session (memory only, lost when pi exits). Tool results show it as ${SECRET_MASK}.`,
            }],
            details: { name: params.name },
          };
        }
      }
    },
  });

  // Every tool result, nested ones included, reaches the model and the
  // session with the session's secrets masked.
  pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
    const masked = sessionSecrets.mask(ctx.sessionManager.getSessionId(), {
      content: event.content,
      structuredContent: event.structuredContent,
      details: event.details,
    });
    if (masked.changed) {
      return masked.value;
    } else {
      return undefined; // no secret in this result
    }
  });
}
