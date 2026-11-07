/**
 * The user's ⚙️ Account topic: a pinned card with Login (OAuth providers),
 * Secrets (the user's own cage store), Key (the server SSH key) and Sessions.
 * Lists open inside the card; messages are posted only for device codes,
 * requests for input and results.
 *
 * Values typed for secrets and login codes are deleted from the chat as soon
 * as they are read.
 */

import { publicKey } from "./accounts.ts";
import { renderAccountCard, type AccountView } from "./card.ts";
import type { Config, UserConfig } from "./config.ts";
import type { AuthEvent, AuthPrompt, LoginCallbacks, LoginRun, Provider } from "./login.ts";
import { Outbox } from "./outbox.ts";
import { escapeHtml } from "./render.ts";
import { listSecrets, removeSecret, SECRET_NAME, setSecret } from "./secrets.ts";
import type { StateStore } from "./state.ts";
import type { Tg } from "./tg.ts";

export type AccountDeps = {
  config: Config;
  store: StateStore;
  tg: Tg;
  log(line: string): void;
  /** Running processes of the user's sessions. */
  sessionsRunning(userId: number): number;
  /** One line per topic of the user: directory and state. */
  sessionsSummary(userId: number): string[];
  /** The user's secrets or login changed: their processes restart. */
  restartUser(userId: number): void;
  startLogin(user: UserConfig, args: string[], callbacks: LoginCallbacks): LoginRun;
};

export const ACCOUNT_TOPIC_NAME = "⚙️ Account";

type Awaiting =
  | { kind: "secretName" }
  | { kind: "secretValue"; name: string }
  | { kind: "login"; prompt: AuthPrompt; resolve(value: string): void; reject(error: Error): void };

export class Account {
  private readonly deps: AccountDeps;
  private readonly user: UserConfig;
  private outbox: Outbox | undefined;
  private view: AccountView = { kind: "main" };
  private awaiting: Awaiting | undefined;
  private login: LoginRun | undefined;
  private secrets: number | undefined;
  private creating: Promise<Outbox | undefined> | undefined;

  constructor(deps: AccountDeps, user: UserConfig) {
    this.deps = deps;
    this.user = user;
  }

  get threadId(): number | undefined {
    return this.deps.store.user(this.user.telegramId).accountThreadId;
  }

  get quiescent(): boolean {
    return this.awaiting === undefined && this.login === undefined;
  }

  /** The Account topic, created with its card and a welcome on first contact. */
  ensure(): Promise<Outbox | undefined> {
    if (this.outbox !== undefined) {
      return Promise.resolve(this.outbox);
    } else if (this.creating !== undefined) {
      return this.creating;
    } else {
      this.creating = this.open().finally(() => (this.creating = undefined));
      return this.creating;
    }
  }

  private async open(): Promise<Outbox | undefined> {
    const known = this.threadId;
    if (known !== undefined) {
      this.outbox = this.makeOutbox(known);
      return this.outbox;
    }
    let threadId: number;
    try {
      threadId = (await this.deps.tg.createForumTopic(this.user.telegramId, ACCOUNT_TOPIC_NAME)).message_thread_id;
    } catch (error) {
      this.log(`cannot create the Account topic: ${String(error)}`);
      return undefined;
    }
    this.deps.store.updateUser(this.user.telegramId, (u) => {
      u.accountThreadId = threadId;
      u.accountCardMessageId = undefined;
    });
    const outbox = this.makeOutbox(threadId);
    this.outbox = outbox;
    const card = renderAccountCard(this.cardState());
    const cardId = await outbox.send({ html: card.html }, { role: "pinned", keyboard: card.keyboard });
    if (cardId !== undefined) {
      this.deps.store.updateUser(this.user.telegramId, (u) => (u.accountCardMessageId = cardId));
      await outbox.pin(cardId);
    } else {
      // logged by the outbox
    }
    await outbox.send(
      {
        html: [
          `Hi, ${escapeHtml(this.user.name)}! This is your harness agent.`,
          "",
          "• <b>Start a task</b>: write it in a new topic (or just here in the chat list's All). I'll ask which directory to work in.",
          "• <b>Plan / Build</b>: messages plan by default; switch the next message to Build in the pinned card, start it with <code>!</code>, or tap 🔨 Build after a plan.",
          "• While the agent works, write to steer it; ⏹ stops it.",
          "• This topic is your account: logins, secrets, your server SSH key.",
        ].join("\n"),
      },
      { silent: false },
    );
    return outbox;
  }

  private makeOutbox(threadId: number): Outbox {
    return new Outbox(this.deps.tg, this.user.telegramId, threadId, (line) => this.log(line), () => {
      // the user deleted the Account topic: a new one is created on next use
      this.outbox = undefined;
      this.deps.store.updateUser(this.user.telegramId, (u) => {
        u.accountThreadId = undefined;
        u.accountCardMessageId = undefined;
      });
    });
  }

  /** A command from any topic; the answer goes to the Account topic. */
  async command(name: string): Promise<void> {
    switch (name) {
      case "login":
      case "logout":
        await this.card("providers", undefined);
        return;
      case "secret":
      case "secrets":
        await this.card("secrets", undefined);
        return;
      case "whoami":
        await this.card("key", undefined);
        return;
      case "sessions":
        await this.card("sessions", undefined);
        return;
      default:
        await this.ensure();
        this.view = { kind: "main" };
        this.refresh();
        return;
    }
  }

  /** An account card button `a:<action>[:<arg>]`; resolves with the toast text. */
  async card(action: string, arg: string | undefined): Promise<string> {
    const outbox = await this.ensure();
    if (outbox === undefined) return "The Account topic is unavailable";
    switch (action) {
      case "back":
        this.view = { kind: "main" };
        this.refresh();
        return "OK";
      case "key": {
        const key = await publicKey(this.deps.config, this.user);
        await outbox.send(
          {
            html: key !== undefined
              ? `👤 Your server SSH key — add it to GitHub/GitLab for git over SSH, or as a cage recipient:\n<code>${escapeHtml(key)}</code>`
              : "❌ The server SSH key does not exist yet.",
          },
          { silent: false },
        );
        return "Key";
      }
      case "sessions": {
        const lines = this.deps.sessionsSummary(this.user.telegramId);
        await outbox.send({ html: lines.length > 0 ? `📋 Sessions\n${lines.join("\n")}` : "📋 No sessions yet." });
        return "Sessions";
      }
      case "providers":
        return this.showProviders();
      case "login":
      case "logout": {
        const provider = this.view.kind === "providers" ? this.view.providers[Number(arg)] : undefined;
        if (provider === undefined) {
          return "The list is outdated";
        } else {
          void this.runLogin(action, provider);
          return action === "login" ? `Logging in to ${provider.name}` : `Logging out of ${provider.name}`;
        }
      }
      case "secrets":
        return this.showSecrets();
      case "add":
        this.awaiting = { kind: "secretName" };
        await outbox.send({ html: "🔐 Name of the new secret (A-Z, 0-9, _), e.g. <code>OPENAI_API_KEY</code>:" }, { role: "sticky", forceReply: "SECRET_NAME", silent: false });
        return "Name the secret";
      case "del":
        if (arg === undefined) return "Unknown secret";
        this.view = { kind: "confirmDelete", name: arg };
        this.refresh();
        return `Delete ${arg}?`;
      case "delyes": {
        if (arg === undefined) return "Unknown secret";
        const removed = await removeSecret(this.deps.config, this.user, arg);
        if (removed.ok) {
          this.deps.restartUser(this.user.telegramId);
          await outbox.send({ html: `🗑 ${escapeHtml(arg)} deleted. New sessions start without it.` });
        } else {
          await outbox.send({ html: `❌ ${escapeHtml(removed.problem)}` }, { silent: false });
        }
        return this.showSecrets();
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
      await this.outbox?.closeSticky({ html: `${escapeHtml(awaiting.prompt.message)}\n✔️ ${escapeHtml(option.label)}` });
      awaiting.resolve(option.id);
      return option.label;
    }
  }

  /** A text in the Account topic; true when it answered something. */
  async text(text: string, messageId: number): Promise<boolean> {
    const awaiting = this.awaiting;
    const outbox = this.outbox;
    if (outbox === undefined) {
      return false;
    }
    await outbox.userPosted();
    if (awaiting === undefined) {
      await outbox.send({ html: "Use the buttons of the pinned card. Tasks go into their own topics." });
      return true;
    }
    switch (awaiting.kind) {
      case "secretName": {
        const name = text.trim().toUpperCase();
        if (!SECRET_NAME.test(name)) {
          await outbox.send({ html: "❌ Use A-Z, 0-9 and _ (letter or _ first). Try again:" }, { silent: false });
        } else {
          this.awaiting = { kind: "secretValue", name };
          await outbox.closeSticky({ html: `🔐 Name: <code>${escapeHtml(name)}</code>` });
          await outbox.send({ html: `🔐 Value of <code>${escapeHtml(name)}</code> — your message is deleted right away:` }, { role: "sticky", forceReply: "value", silent: false });
        }
        return true;
      }
      case "secretValue": {
        await outbox.delete(messageId);
        this.awaiting = undefined;
        await outbox.closeSticky({ html: `🔐 Value of <code>${escapeHtml(awaiting.name)}</code> received.` });
        const serverKey = await publicKey(this.deps.config, this.user);
        const saved = serverKey === undefined
          ? { ok: false as const, problem: "the server SSH key does not exist yet" }
          : await setSecret(this.deps.config, this.user, serverKey, awaiting.name, text);
        if (saved.ok) {
          this.deps.restartUser(this.user.telegramId);
          await outbox.send({ html: `✅ ${escapeHtml(awaiting.name)} saved. Sessions get it from their next start.` }, { silent: false });
          await this.showSecrets();
        } else {
          await outbox.send({ html: `❌ ${escapeHtml(saved.problem)}` }, { silent: false });
        }
        return true;
      }
      case "login": {
        if (awaiting.prompt.type === "secret" || awaiting.prompt.type === "manual_code") await outbox.delete(messageId);
        this.awaiting = undefined;
        await outbox.closeSticky({ html: `${escapeHtml(awaiting.prompt.message)}\n✔️ received` });
        awaiting.resolve(text.trim());
        return true;
      }
      default:
        return assertNever(awaiting);
    }
  }

  /** /stop in the Account topic: cancels the login or the pending input. */
  async stop(): Promise<void> {
    const awaiting = this.awaiting;
    this.awaiting = undefined;
    if (awaiting?.kind === "login") awaiting.reject(new Error("cancelled"));
    this.login?.cancel();
    if (awaiting !== undefined) await this.outbox?.closeSticky({ html: "⏹ cancelled" });
  }

  /** Refreshes the card (e.g. the number of running sessions changed). */
  refresh(): void {
    const cardId = this.deps.store.user(this.user.telegramId).accountCardMessageId;
    if (this.outbox !== undefined && cardId !== undefined) {
      const card = renderAccountCard(this.cardState());
      void this.outbox.edit(cardId, { html: card.html }, card.keyboard);
    } else {
      // no Account topic yet
    }
  }

  /* ------------------------------------------------------------------------ */

  private async showProviders(): Promise<string> {
    const run = this.deps.startLogin(this.user, ["list"], { prompt: () => Promise.reject(new Error("no prompts")), notify: () => undefined });
    const result = await run.result;
    if (result.ok) {
      this.view = { kind: "providers", providers: result.providers ?? [] };
      this.refresh();
      return "Choose a provider";
    } else {
      await this.outbox?.send({ html: `❌ ${escapeHtml(result.problem)}` }, { silent: false });
      return "Failed";
    }
  }

  private async showSecrets(): Promise<string> {
    const listed = await listSecrets(this.deps.config, this.user);
    if ("names" in listed) {
      this.secrets = listed.names.length;
      this.view = { kind: "secrets", names: listed.names };
      this.refresh();
      return listed.names.length > 0 ? "Your secrets" : "No secrets yet";
    } else {
      await this.outbox?.send({ html: `❌ ${escapeHtml(listed.problem)}` }, { silent: false });
      return "Failed";
    }
  }

  private async runLogin(action: "login" | "logout", provider: Provider): Promise<void> {
    const outbox = this.outbox;
    if (outbox === undefined || this.login !== undefined) return;
    const run = this.deps.startLogin(this.user, [action, provider.id], {
      prompt: (prompt) => this.askLogin(prompt),
      notify: (event) => void this.notifyLogin(event),
    });
    this.login = run;
    const result = await run.result;
    this.login = undefined;
    if (this.awaiting?.kind === "login") {
      this.awaiting = undefined;
      await outbox.closeSticky({ html: "⌛ closed" });
    } else {
      // no prompt left open
    }
    if (result.ok) {
      this.deps.restartUser(this.user.telegramId);
      await outbox.send({ html: action === "login" ? `✅ Logged in to ${escapeHtml(provider.name)}.` : `✅ Logged out of ${escapeHtml(provider.name)}.` }, { silent: false });
    } else {
      await outbox.send({ html: `❌ ${escapeHtml(provider.name)}: ${escapeHtml(result.problem)}` }, { silent: false });
    }
    await this.showProviders();
  }

  private askLogin(prompt: AuthPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      this.awaiting = { kind: "login", prompt, resolve, reject };
      const message = escapeHtml(prompt.message);
      if (prompt.type === "select") {
        void this.outbox?.send(
          { html: message },
          { role: "sticky", silent: false, keyboard: prompt.options.map((option, index) => [{ text: option.label.slice(0, 60), callback_data: `l:${index}` }]) },
        );
      } else {
        const hint = prompt.type === "secret" || prompt.type === "manual_code" ? "\n(your reply is deleted right away)" : "";
        void this.outbox?.send({ html: `${message}${hint}` }, { role: "sticky", silent: false, forceReply: prompt.placeholder ?? "Reply…" });
      }
    });
  }

  private async notifyLogin(event: AuthEvent): Promise<void> {
    const outbox = this.outbox;
    if (outbox === undefined) return;
    switch (event.type) {
      case "device_code":
        await outbox.send(
          { html: `🔑 Enter this code: <code>${escapeHtml(event.userCode)}</code> (tap to copy)` },
          { silent: false, keyboard: [[{ text: "Open", url: event.verificationUri }]] },
        );
        return;
      case "auth_url":
        await outbox.send(
          { html: `🔑 ${escapeHtml(event.instructions ?? "Open the link to log in.")}` },
          { silent: false, keyboard: [[{ text: "Open", url: event.url }]] },
        );
        return;
      case "info":
      case "progress":
        await outbox.send({ html: escapeHtml(event.message) });
        return;
      default:
        assertNever(event);
    }
  }

  private cardState(): Parameters<typeof renderAccountCard>[0] {
    return {
      name: this.user.name,
      uid: this.user.uid,
      secrets: this.secrets,
      sessionsRunning: this.deps.sessionsRunning(this.user.telegramId),
      view: this.view,
    };
  }

  private log(line: string): void {
    this.deps.log(`${this.user.name}/account: ${line}`);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
