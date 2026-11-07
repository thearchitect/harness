/**
 * The user's account, from ⚙️ More (or /login, /secrets, /key, /sessions) in
 * whatever topic they are: Login (OAuth providers), Secrets (their own cage
 * store), Key (the server SSH key), Sessions, Help. Everything happens at the
 * bottom of that topic: panels, requests for input, results.
 *
 * Values typed for secrets and login codes are deleted from the chat as soon
 * as they are read.
 */

import { publicKey } from "./accounts.ts";
import { deleteSecretPanel, providersPanel, secretsPanel } from "./card.ts";
import type { Config, UserConfig } from "./config.ts";
import type { AuthEvent, AuthPrompt, LoginCallbacks, LoginRun, Provider } from "./login.ts";
import type { Outbox } from "./outbox.ts";
import { escapeHtml } from "./render.ts";
import { listSecrets, removeSecret, SECRET_NAME, setSecret } from "./secrets.ts";

export type AccountDeps = {
  config: Config;
  log(line: string): void;
  /** One line per open session of the user: directory and state. */
  sessionsSummary(userId: number): string[];
  /** The user's secrets or login changed: their processes restart. */
  restartUser(userId: number): void;
  startLogin(user: UserConfig, args: string[], callbacks: LoginCallbacks): LoginRun;
  help: string;
};

type Awaiting =
  | { kind: "secretName" }
  | { kind: "secretValue"; name: string }
  | { kind: "login"; prompt: AuthPrompt; resolve(value: string): void; reject(error: Error): void };

export class Account {
  private readonly deps: AccountDeps;
  private readonly user: UserConfig;
  /** Where the account was last used: inputs and login output go there. */
  private place: Outbox | undefined;
  private awaiting: Awaiting | undefined;
  private login: LoginRun | undefined;
  private providers: Provider[] = [];

  constructor(deps: AccountDeps, user: UserConfig) {
    this.deps = deps;
    this.user = user;
  }

  get quiescent(): boolean {
    return this.awaiting === undefined && this.login === undefined;
  }

  /** The account waits for a text in this place (a secret, a login code). */
  awaitsText(place: Outbox): boolean {
    return this.awaiting !== undefined && this.place === place;
  }

  /** A command: /login, /secrets, /key, /sessions. */
  async command(name: string, place: Outbox): Promise<void> {
    const action = { login: "providers", logout: "providers", secret: "secrets", secrets: "secrets", key: "key", whoami: "key", sessions: "sessions" }[name] ?? "help";
    await this.panelAction(action, undefined, place);
  }

  /** An account panel button `a:<action>[:<arg>]` in `place`; resolves with the toast text. */
  async panelAction(action: string, arg: string | undefined, place: Outbox): Promise<string> {
    this.place = place;
    switch (action) {
      case "dismiss":
        await place.closePanel(undefined);
        return "OK";
      case "help":
        await place.closePanel(this.deps.help);
        return "Help";
      case "key": {
        const key = await publicKey(this.deps.config, this.user);
        await place.closePanel(
          key !== undefined
            ? `👤 Your server SSH key — add it to GitHub/GitLab for git over SSH, or as a cage recipient:\n<code>${escapeHtml(key)}</code>`
            : "❌ The server SSH key does not exist yet.",
        );
        return "Key";
      }
      case "sessions": {
        const lines = this.deps.sessionsSummary(this.user.telegramId);
        await place.closePanel(lines.length > 0 ? `📋 <b>Sessions</b>\n${lines.join("\n")}` : "📋 No sessions yet.");
        return "Sessions";
      }
      case "providers":
        return this.showProviders(place);
      case "login":
      case "logout": {
        const provider = this.providers[Number(arg)];
        if (provider === undefined) {
          await place.closePanel("❌ The list is outdated — open it again.");
          return "Failed";
        } else if (this.login !== undefined) {
          return "Another login is in progress";
        } else {
          await place.closePanel(`🔑 ${action === "login" ? "Logging in to" : "Logging out of"} ${escapeHtml(provider.name)}…`);
          void this.runLogin(action, provider, place);
          return provider.name;
        }
      }
      case "secrets":
        return this.showSecrets(place);
      case "add":
        this.awaiting = { kind: "secretName" };
        await place.closePanel("🔐 New secret");
        await place.send({ html: "🔐 Name of the new secret (A-Z, 0-9, _), e.g. <code>OPENAI_API_KEY</code>:" }, { role: "sticky", forceReply: "SECRET_NAME", silent: false });
        return "Name the secret";
      case "del":
        if (arg === undefined) return "Unknown secret";
        await place.showPanel(deleteSecretPanel(arg));
        return `Delete ${arg}?`;
      case "delyes": {
        if (arg === undefined) return "Unknown secret";
        const removed = await removeSecret(this.deps.config, this.user, arg);
        if (removed.ok) {
          this.deps.restartUser(this.user.telegramId);
          await place.closePanel(`🗑 ${escapeHtml(arg)} deleted. New sessions start without it.`);
        } else {
          await place.closePanel(`❌ ${escapeHtml(removed.problem)}`);
        }
        return "Deleted";
      }
      default:
        return "Unknown action";
    }
  }

  /** A login prompt button `l:<index>`. */
  async loginChoice(index: number): Promise<string> {
    const awaiting = this.awaiting;
    if (awaiting?.kind !== "login" || awaiting.prompt.type !== "select") {
      return "This question is closed.";
    } else {
      const option = awaiting.prompt.options[index];
      if (option === undefined) return "Unknown option";
      this.awaiting = undefined;
      await this.place?.closeSticky({ html: `${escapeHtml(awaiting.prompt.message)}\n✔️ ${escapeHtml(option.label)}` });
      awaiting.resolve(option.id);
      return option.label;
    }
  }

  /** A text where the account waits for one (awaitsText). */
  async text(text: string, messageId: number): Promise<void> {
    const awaiting = this.awaiting;
    const place = this.place;
    if (awaiting === undefined || place === undefined) return;
    switch (awaiting.kind) {
      case "secretName": {
        const name = text.trim().toUpperCase();
        if (!SECRET_NAME.test(name)) {
          await place.send({ html: "❌ Use A-Z, 0-9 and _ (letter or _ first). Try again:" }, { silent: false });
        } else {
          this.awaiting = { kind: "secretValue", name };
          await place.closeSticky({ html: `🔐 Name: <code>${escapeHtml(name)}</code>` });
          await place.send({ html: `🔐 Value of <code>${escapeHtml(name)}</code> — your message is deleted right away:` }, { role: "sticky", forceReply: "value", silent: false });
        }
        return;
      }
      case "secretValue": {
        await place.delete(messageId);
        this.awaiting = undefined;
        await place.closeSticky({ html: `🔐 Value of <code>${escapeHtml(awaiting.name)}</code> received.` });
        const serverKey = await publicKey(this.deps.config, this.user);
        const saved = serverKey === undefined
          ? { ok: false as const, problem: "the server SSH key does not exist yet" }
          : await setSecret(this.deps.config, this.user, serverKey, awaiting.name, text);
        if (saved.ok) {
          this.deps.restartUser(this.user.telegramId);
          await place.send({ html: `✅ ${escapeHtml(awaiting.name)} saved. Sessions get it from their next start.` }, { silent: false });
        } else {
          await place.send({ html: `❌ ${escapeHtml(saved.problem)}` }, { silent: false });
        }
        return;
      }
      case "login": {
        if (awaiting.prompt.type === "secret" || awaiting.prompt.type === "manual_code") await place.delete(messageId);
        this.awaiting = undefined;
        await place.closeSticky({ html: `${escapeHtml(awaiting.prompt.message)}\n✔️ received` });
        awaiting.resolve(text.trim());
        return;
      }
      default:
        assertNever(awaiting);
    }
  }

  /** /stop or ⏹ where the account waits: cancels the login or the pending input. */
  async stop(): Promise<void> {
    const awaiting = this.awaiting;
    this.awaiting = undefined;
    if (awaiting?.kind === "login") awaiting.reject(new Error("cancelled"));
    this.login?.cancel();
    if (awaiting !== undefined) await this.place?.closeSticky({ html: "⏹ cancelled" });
  }

  /* ------------------------------------------------------------------------ */

  private async showProviders(place: Outbox): Promise<string> {
    const run = this.deps.startLogin(this.user, ["list"], { prompt: () => Promise.reject(new Error("no prompts")), notify: () => undefined });
    const result = await run.result;
    if (result.ok) {
      this.providers = result.providers ?? [];
      await place.showPanel(providersPanel(this.providers));
      return "Choose a provider";
    } else {
      await place.closePanel(`❌ ${escapeHtml(result.problem)}`);
      return "Failed";
    }
  }

  private async showSecrets(place: Outbox): Promise<string> {
    const listed = await listSecrets(this.deps.config, this.user);
    if ("names" in listed) {
      await place.showPanel(secretsPanel(listed.names));
      return listed.names.length > 0 ? "Your secrets" : "No secrets yet";
    } else {
      await place.closePanel(`❌ ${escapeHtml(listed.problem)}`);
      return "Failed";
    }
  }

  private async runLogin(action: "login" | "logout", provider: Provider, place: Outbox): Promise<void> {
    const run = this.deps.startLogin(this.user, [action, provider.id], {
      prompt: (prompt) => this.askLogin(prompt, place),
      notify: (event) => void this.notifyLogin(event, place),
    });
    this.login = run;
    const result = await run.result;
    this.login = undefined;
    if (this.awaiting?.kind === "login") {
      this.awaiting = undefined;
      await place.closeSticky({ html: "⌛ closed" });
    } else {
      // no prompt left open
    }
    if (result.ok) {
      this.deps.restartUser(this.user.telegramId);
      await place.send({ html: action === "login" ? `✅ Logged in to ${escapeHtml(provider.name)}.` : `✅ Logged out of ${escapeHtml(provider.name)}.` }, { silent: false });
    } else {
      await place.send({ html: `❌ ${escapeHtml(provider.name)}: ${escapeHtml(result.problem)}` }, { silent: false });
    }
  }

  private askLogin(prompt: AuthPrompt, place: Outbox): Promise<string> {
    return new Promise((resolve, reject) => {
      this.awaiting = { kind: "login", prompt, resolve, reject };
      this.place = place;
      const message = escapeHtml(prompt.message);
      if (prompt.type === "select") {
        void place.send(
          { html: message },
          { role: "sticky", silent: false, keyboard: prompt.options.map((option, index) => [{ text: option.label.slice(0, 60), callback_data: `l:${index}` }]) },
        );
      } else {
        const hint = prompt.type === "secret" || prompt.type === "manual_code" ? "\n(your reply is deleted right away)" : "";
        void place.send({ html: `${message}${hint}` }, { role: "sticky", silent: false, forceReply: prompt.placeholder ?? "Reply…" });
      }
    });
  }

  private async notifyLogin(event: AuthEvent, place: Outbox): Promise<void> {
    switch (event.type) {
      case "device_code":
        await place.send(
          { html: `🔑 Enter this code: <code>${escapeHtml(event.userCode)}</code> (tap to copy)` },
          { silent: false, keyboard: [[{ text: "Open", url: event.verificationUri }]] },
        );
        return;
      case "auth_url":
        await place.send(
          { html: `🔑 ${escapeHtml(event.instructions ?? "Open the link to log in.")}` },
          { silent: false, keyboard: [[{ text: "Open", url: event.url }]] },
        );
        return;
      case "info":
      case "progress":
        await place.send({ html: escapeHtml(event.message) });
        return;
      default:
        assertNever(event);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
