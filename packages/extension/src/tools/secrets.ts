/**
 * Session secrets: values the operator gave through ask_secret. Kept in memory per session
 * (globalThis, so a reload keeps them; gone when the agent exits), given to every bash command
 * and background task of the session as environment variables, and masked in every tool result.
 */

/** What a secret value becomes in tool results: cage's mask, which cage refuses to store. */
export const SECRET_MASK = "****************";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Why a variable name cannot hold a secret, or undefined when it can. */
export function secretNameProblem(name: string): string | undefined {
  if (!SECRET_NAME.test(name)) {
    return `${name} is not a variable name: use A-Z, 0-9 and _, not starting with a digit`;
  } else if (name in process.env) {
    return `${name} is already set in the agent's environment: choose another name`;
  } else {
    return undefined;
  }
}

/** A value with every secret replaced by the mask, and whether anything was replaced. */
export type Masked<T> = { value: T; changed: boolean };

type SessionStore = Map<string, Map<string, string>>;

const STORE_KEY = Symbol.for("harness.secrets");

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

  /** The variables a command of the session gets. */
  env(sessionId: string): Record<string, string> {
    return Object.fromEntries(sessionStore().get(sessionId) ?? []);
  },

  /** Every string inside value with the session's secrets masked, longest first. */
  mask<T>(sessionId: string, value: T): Masked<T> {
    const secrets = [...(sessionStore().get(sessionId)?.values() ?? [])].sort((a, b) => b.length - a.length);
    return maskDeep(value, secrets) as Masked<T>;
  },
};
