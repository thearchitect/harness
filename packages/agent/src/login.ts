// Logging in to model providers on the agent's machine (where auth.json lives), from any client:
// pi's login flow runs here, and each of its steps is a `login` interaction — what it shows (the
// sign-in link, a device code, progress) and what it asks (a line, a secret, a choice). The operator
// answers, goes back one step, or cancels.
//
// Back: pi's flows cannot step back, so the flow starts again and the answers of the steps before
// the previous one are given again by themselves — the operator lands on the previous step (a new
// sign-in link where it had one). Back from the first step ends the login with `back`: the client
// shows the providers again.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { Interactions } from "#extension/host.ts";
import type { LoginAnswer, LoginPayload, LoginPrompt } from "#protocol/interactions.ts";
import type { LoginProvider } from "#protocol/hap.ts";

export function loginProviders(session: AgentSession): LoginProvider[] {
  const runtime = session.modelRuntime;
  return runtime.getProviders().flatMap((provider) => {
    const configured = runtime.getProviderAuthStatus(provider.id).configured;
    const subscription = provider.auth.oauth?.isSubscription === true;
    return [
      ...(provider.auth.oauth !== undefined ? [{ id: provider.id, name: provider.name, authType: "oauth" as const, configured, subscription }] : []),
      ...(provider.auth.apiKey?.login !== undefined ? [{ id: provider.id, name: provider.name, authType: "api_key" as const, configured, subscription }] : []),
    ];
  });
}

/** The operator went back: the flow starts again with `replay` (the answers to give by themselves). */
class Back extends Error {
  readonly replay: string[];

  constructor(replay: string[]) {
    super("back");
    this.replay = replay;
  }
}

class Cancelled extends Error {
  constructor() {
    super("Login cancelled");
  }
}

function loginPrompt(prompt: AuthPrompt): LoginPrompt {
  switch (prompt.type) {
    case "text":
    case "manual_code":
    case "secret":
      return { type: prompt.type, message: prompt.message, ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}) };
    case "select":
      return { type: "select", message: prompt.message, options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) })) };
    default:
      throw new Error(`unknown login prompt: ${JSON.stringify(prompt satisfies never)}`);
  }
}

/** One run of a provider's flow: the steps it showed, the answers given; a step at a time asks the operator. */
class LoginRun {
  private readonly interactions: Interactions;
  private readonly title: string;
  private readonly controller = new AbortController();
  /** Answers to give again by themselves (after a back), in order. */
  private readonly replay: string[];
  /** The answers of this run, in order: what a back replays. */
  readonly answers: string[] = [];
  private shown: Omit<LoginPayload, "title" | "prompt"> = { progress: [] };
  private waiting: AbortController | undefined;
  /** How the run ended early by the operator (back or cancel while nothing was asked). */
  private ended: Back | Cancelled | undefined;

  constructor(interactions: Interactions, title: string, replay: string[]) {
    this.interactions = interactions;
    this.title = title;
    this.replay = [...replay];
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The operator's end of the run, if they ended it while it waited. */
  get outcome(): Back | Cancelled | undefined {
    return this.ended;
  }

  private payload(prompt?: LoginPrompt): LoginPayload {
    return { title: this.title, ...this.shown, ...(prompt !== undefined ? { prompt } : {}) };
  }

  /** Back from the current step: the answers before the previous one are given again. */
  private back(): Back {
    return new Back(this.answers.slice(0, -1));
  }

  /** A step shown while nothing is asked: the operator may go back or cancel. */
  notify(event: AuthEvent): void {
    switch (event.type) {
      case "auth_url":
        this.shown = { ...this.shown, url: event.url, ...(event.instructions !== undefined ? { instructions: event.instructions } : {}) };
        break;
      case "device_code":
        this.shown = { ...this.shown, deviceCode: { uri: event.verificationUri, code: event.userCode } };
        break;
      case "info":
        this.shown = { ...this.shown, progress: [...this.shown.progress, [event.message, ...(event.links ?? []).map((link) => `${link.label ?? "link"}: ${link.url}`)].join("\n")].slice(-6) };
        break;
      case "progress":
        this.shown = { ...this.shown, progress: [...this.shown.progress, event.message].slice(-6) };
        break;
      default:
        throw new Error(`unknown login event: ${JSON.stringify(event satisfies never)}`);
    }
    if (this.replay.length > 0) {
      return; // going back through the steps given again: nothing to show yet
    } else {
      this.waiting?.abort();
      const waiting = new AbortController();
      this.waiting = waiting;
      void this.interactions.ask("login", this.payload(), { signal: waiting.signal }).then((answer) => {
        if (answer === undefined || waiting.signal.aborted) {
          // replaced by the next step, or the run ended
        } else if ("back" in answer) {
          this.ended = this.back();
          this.controller.abort();
        } else {
          this.ended = new Cancelled(); // cancelled (or dismissed) while waiting
          this.controller.abort();
        }
      });
    }
  }

  async prompt(prompt: AuthPrompt): Promise<string> {
    this.waiting?.abort();
    this.waiting = undefined;
    const replayed = this.replay.shift();
    if (replayed !== undefined) {
      this.answers.push(replayed);
      return replayed;
    } else {
      const signal = prompt.signal !== undefined ? AbortSignal.any([prompt.signal, this.controller.signal]) : this.controller.signal;
      const answer: LoginAnswer | undefined = await this.interactions.ask("login", this.payload(loginPrompt(prompt)), { signal });
      if (answer === undefined || "cancelled" in answer) {
        throw new Cancelled();
      } else if ("back" in answer) {
        throw this.back();
      } else {
        const value = "option" in answer ? answer.option : answer.value.trim();
        if (value === "") {
          throw new Cancelled();
        } else {
          this.answers.push(value);
          return value;
        }
      }
    }
  }

  end(): void {
    this.waiting?.abort();
  }
}

/**
 * Runs a provider's login; resolves `{}` when it succeeded, `{ back: true }` when the operator went
 * back from its first step, rejects with the reason otherwise (a cancel among them).
 */
export async function login(session: AgentSession, interactions: Interactions, provider: string, authType: AuthType): Promise<{ back?: true }> {
  const known = loginProviders(session).find((candidate) => candidate.id === provider && candidate.authType === authType);
  if (known === undefined) {
    throw new Error(`no ${authType === "oauth" ? "account" : "API key"} login for ${provider}`);
  } else {
    let replay: string[] = [];
    for (;;) {
      const run = new LoginRun(interactions, `Log in to ${known.name}`, replay);
      try {
        // the installation's id, as pi gives it: Sign in with ChatGPT names the device it authorizes
        await session.modelRuntime.login(
          provider,
          authType,
          { signal: run.signal, prompt: (prompt) => run.prompt(prompt), notify: (event) => run.notify(event) },
          { getDeviceId: () => session.settingsManager.getOrCreateDeviceId() },
        );
        return {};
      } catch (error) {
        const reason = run.outcome ?? error;
        if (reason instanceof Back && run.answers.length === 0) {
          return { back: true }; // back from the first step: the providers again
        } else if (reason instanceof Back) {
          replay = reason.replay;
        } else {
          throw reason;
        }
      } finally {
        run.end();
      }
    }
  }
}
