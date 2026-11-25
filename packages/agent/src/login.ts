// Logging in to model providers on the agent's machine (where auth.json lives), from any client:
// pi's login flow runs here, and each of its steps becomes a typed interaction — a prompt for text
// or a pasted code is a question, a secret is a secret, a choice is a choice; links, device codes and
// progress stay on screen as a waiting choice ("Cancel login") until the next step replaces it.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { Interactions } from "#extension/host.ts";
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

function eventLine(event: AuthEvent): string {
  switch (event.type) {
    case "info":
      return [event.message, ...(event.links ?? []).map((link) => `${link.label ?? "link"}: ${link.url}`)].join("\n");
    case "auth_url":
      return `Open: ${event.url}${event.instructions !== undefined ? `\n${event.instructions}` : ""}`;
    case "device_code":
      return `Go to ${event.verificationUri} and enter the code ${event.userCode}`;
    case "progress":
      return event.message;
    default:
      throw new Error(`unknown login event: ${JSON.stringify(event satisfies never)}`);
  }
}

class LoginFlow {
  private readonly interactions: Interactions;
  private readonly title: string;
  private readonly controller = new AbortController();
  private lines: string[] = [];
  private waiting: AbortController | undefined;

  constructor(interactions: Interactions, title: string) {
    this.interactions = interactions;
    this.title = title;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The steps so far, shown while nothing is asked: the operator may only cancel. */
  notify(event: AuthEvent): void {
    this.lines = [...this.lines, eventLine(event)].slice(-6);
    this.waiting?.abort();
    const waiting = new AbortController();
    this.waiting = waiting;
    void this.interactions
      .ask("choice", { title: this.title, message: this.lines.join("\n"), options: [{ id: "cancel", title: "Cancel login" }] }, { signal: waiting.signal })
      .then((answer) => {
        if (answer !== undefined && !waiting.signal.aborted) {
          this.controller.abort(); // cancelled (or dismissed) while waiting
        } else {
          // replaced by the next step, or the flow ended
        }
      });
  }

  async prompt(prompt: AuthPrompt): Promise<string> {
    this.waiting?.abort();
    this.waiting = undefined;
    const signal = prompt.signal !== undefined ? AbortSignal.any([prompt.signal, this.controller.signal]) : this.controller.signal;
    const context = this.lines.join("\n");
    const cancelled = (): never => {
      throw new Error("Login cancelled");
    };
    switch (prompt.type) {
      case "text":
      case "manual_code": {
        const answer = await this.interactions.ask(
          "questions",
          { questions: [{ question: prompt.message, ...(context !== "" ? { context } : {}), options: [], allowMultiple: false, allowFreeform: true }] },
          { signal },
        );
        const value = answer !== undefined && "answers" in answer ? answer.answers[0]?.freeform : undefined;
        return value !== undefined && value !== "" ? value : cancelled();
      }
      case "secret": {
        const answer = await this.interactions.ask("secret", { name: this.title, description: [prompt.message, context].filter((line) => line !== "").join("\n"), replaces: false }, { signal });
        return answer !== undefined && "value" in answer ? answer.value : cancelled();
      }
      case "select": {
        const answer = await this.interactions.ask(
          "choice",
          { title: prompt.message, ...(context !== "" ? { message: context } : {}), options: prompt.options.map((option) => ({ id: option.id, title: option.label, ...(option.description !== undefined ? { description: option.description } : {}) })) },
          { signal },
        );
        return answer !== undefined && "id" in answer ? answer.id : cancelled();
      }
      default:
        throw new Error(`unknown login prompt: ${JSON.stringify(prompt satisfies never)}`);
    }
  }

  end(): void {
    this.waiting?.abort();
  }
}

/** Runs a provider's login; resolves when it succeeded, rejects with the reason otherwise. */
export async function login(session: AgentSession, interactions: Interactions, provider: string, authType: AuthType): Promise<void> {
  const known = loginProviders(session).find((candidate) => candidate.id === provider && candidate.authType === authType);
  if (known === undefined) {
    throw new Error(`no ${authType === "oauth" ? "account" : "API key"} login for ${provider}`);
  } else {
    const flow = new LoginFlow(interactions, `Log in to ${known.name}`);
    try {
      // the installation's id, as pi gives it: Sign in with ChatGPT names the device it authorizes
      await session.modelRuntime.login(
        provider,
        authType,
        { signal: flow.signal, prompt: (prompt) => flow.prompt(prompt), notify: (event) => flow.notify(event) },
        { getDeviceId: () => session.settingsManager.getOrCreateDeviceId() },
      );
    } finally {
      flow.end();
    }
  }
}
