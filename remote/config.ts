/**
 * The gateway configuration: remote.yaml of a deployment, completed by
 * lib.mkRemoteImage with the paths of the image (JSON is valid YAML, so the
 * image's config.json is read by the same parser).
 *
 * Every problem is reported with the path of its field; the gateway does not
 * start on an invalid configuration.
 */

import { parse } from "yaml";

export type UserConfig = {
  name: string;
  telegramId: number;
  uid: number;
  gid: number;
  git: { name: string; email: string };
  publicKeys: string[];
};

export type Limits = {
  sessionsPerUser: number;
  sessionsTotal: number;
  idleMinutes: number;
  idleShutdownMinutes: number;
};

export type Config = {
  telegram: {
    tokenVariable: string;
    webhookSecretVariable: string;
    publicUrl: string;
    listenPort: number;
  };
  /** users: every user gets their uid (the gateway runs as root); self: one-user local runs under the gateway's own uid. */
  runAs: "users" | "self";
  dataDir: string;
  paths: {
    pi: string;
    cage: string;
    envsDir: string;
    machineIdentity: string;
  };
  users: UserConfig[];
  limits: Limits;
  defaultSettings: Record<string, unknown>;
};

const USER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Parses and checks a configuration text; `isRoot` is whether the gateway runs as root. */
export function parseConfig(text: string, isRoot: boolean): { config: Config } | { problems: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { problems: [`not valid YAML/JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const problems: string[] = [];
  const r = new Reader(raw, problems);

  const telegram = r.object("telegram");
  const runAs = r.oneOf("runAs", ["users", "self"] as const);
  const config: Config = {
    telegram: {
      tokenVariable: telegram.string("tokenVariable"),
      webhookSecretVariable: telegram.string("webhookSecretVariable"),
      publicUrl: telegram.string("publicUrl"),
      listenPort: telegram.integer("listenPort", 1, 65535),
    },
    runAs,
    dataDir: r.string("dataDir"),
    paths: (() => {
      const paths = r.object("paths");
      return {
        pi: paths.string("pi"),
        cage: paths.string("cage"),
        envsDir: paths.string("envsDir"),
        machineIdentity: paths.string("machineIdentity"),
      };
    })(),
    users: r.array("users").map((user) => {
      const uid = user.integer("uid", 1000, 65533);
      const git = user.object("git");
      return {
        name: user.match("name", USER_NAME),
        telegramId: user.integer("telegramId", 1, Number.MAX_SAFE_INTEGER),
        uid,
        gid: uid, // every user has a group of their own, with the uid's number
        git: { name: git.string("name"), email: git.string("email") },
        publicKeys: user.stringArray("publicKeys"),
      };
    }),
    limits: (() => {
      const limits = r.object("limits");
      return {
        sessionsPerUser: limits.integer("sessionsPerUser", 1, 64),
        sessionsTotal: limits.integer("sessionsTotal", 1, 256),
        idleMinutes: limits.integer("idleMinutes", 1, 24 * 60),
        idleShutdownMinutes: limits.integer("idleShutdownMinutes", 1, 24 * 60),
      };
    })(),
    defaultSettings: r.record("defaultSettings"),
  };

  if (config.telegram.publicUrl !== "" && !config.telegram.publicUrl.startsWith("https://")) {
    problems.push("telegram.publicUrl: must be an https:// URL");
  } else {
    // a valid or already reported URL
  }
  if (config.users.length === 0 && problems.length === 0) {
    problems.push("users: at least one user is required");
  } else {
    // users present, or the array itself was reported
  }
  for (const field of ["name", "uid", "telegramId"] as const) {
    const seen = new Set<string | number>();
    config.users.forEach((user, index) => {
      if (seen.has(user[field])) {
        problems.push(`users[${index}].${field}: duplicate ${String(user[field])}`);
      } else {
        seen.add(user[field]);
      }
    });
  }
  if (config.runAs === "users" && !isRoot) {
    problems.push("runAs: users requires the gateway to run as root");
  } else if (config.runAs === "self" && config.users.length > 1) {
    problems.push("runAs: self serves one user only");
  } else {
    // the runAs mode fits the process
  }

  return problems.length > 0 ? { problems } : { config };
}

/** Reads typed fields of one object, recording a problem (with its path) for each bad field. */
class Reader {
  private readonly value: Record<string, unknown>;
  private readonly path: string;
  private readonly problems: string[];

  constructor(value: unknown, problems: string[], path = "") {
    this.problems = problems;
    this.path = path;
    if (isRecord(value)) {
      this.value = value;
    } else {
      this.value = {};
      problems.push(`${path || "<root>"}: must be an object`);
    }
  }

  private at(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }

  private bad(key: string, expected: string): void {
    this.problems.push(`${this.at(key)}: ${this.value[key] === undefined ? "missing" : "must be"} ${expected}`);
  }

  string(key: string): string {
    const v = this.value[key];
    if (typeof v === "string" && v !== "") {
      return v;
    } else {
      this.bad(key, "a non-empty string");
      return "";
    }
  }

  match(key: string, pattern: RegExp): string {
    const v = this.string(key);
    if (v !== "" && !pattern.test(v)) {
      this.problems.push(`${this.at(key)}: must match ${String(pattern)}`);
    } else {
      // matches, or already reported as missing
    }
    return v;
  }

  integer(key: string, min: number, max: number): number {
    const v = this.value[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) {
      return v;
    } else {
      this.bad(key, `an integer in ${min}..${max}`);
      return 0;
    }
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const v = this.value[key];
    if (typeof v === "string" && (values as readonly string[]).includes(v)) {
      return v as T;
    } else {
      this.bad(key, `one of ${values.join(", ")}`);
      return values[0] as T;
    }
  }

  object(key: string): Reader {
    return new Reader(this.value[key], this.problems, this.at(key));
  }

  record(key: string): Record<string, unknown> {
    const v = this.value[key];
    if (isRecord(v)) {
      return v;
    } else {
      this.bad(key, "an object");
      return {};
    }
  }

  array(key: string): Reader[] {
    const v = this.value[key];
    if (Array.isArray(v)) {
      return v.map((item, index) => new Reader(item, this.problems, `${this.at(key)}[${index}]`));
    } else {
      this.bad(key, "an array");
      return [];
    }
  }

  stringArray(key: string): string[] {
    const v = this.value[key];
    if (Array.isArray(v) && v.every((item) => typeof item === "string" && item !== "")) {
      return v as string[];
    } else {
      this.bad(key, "an array of non-empty strings");
      return [];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
