// Subagent profiles (plan 12.1): `<source>/subagents/<name>/SUBAGENT.md` (frontmatter: the profile;
// body: the role, the subagent's own instructions) and `SKILL.md` (the briefing the calling model
// reads when it delegates). Sources, earlier wins on a name: the project's `.harness/subagents/`
// (trusted projects only), `~/.harness/subagents/`, the bundle's. A profile with an error is left
// out and reported.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { isNotifyPolicy, type NotifyPolicy, type RunMode, type SubagentEngine } from "#protocol/state.ts";

export type ProfileMode = RunMode | "inherit";

export type SubagentProfile = {
  name: string;
  description: string;
  engine: SubagentEngine;
  /** A model reference (`provider/family[:thinking]`); the engine's default when absent. */
  model?: string;
  mode: ProfileMode;
  tools: { allow?: string[]; deny?: string[] };
  background: boolean;
  notify: NotifyPolicy;
  subagents: string[];
  role: string;
  /** The briefing skill (SKILL.md), registered as a pi skill. */
  skillPath: string;
  source: "project" | "user" | "bundle";
  dir: string;
};

export type Registry = { profiles: Map<string, SubagentProfile>; problems: string[] };

export const BUNDLED_DIR = join(import.meta.dirname, "bundled");

/** Thinking levels the `claude` engine maps to `--effort`. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const NAME = /^[a-z][a-z0-9-]*$/;

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new Error("no frontmatter (--- … ---) at the top");
  } else {
    const data = parse(match[1] ?? "") as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("the frontmatter is not a mapping");
    } else {
      return { data: data as Record<string, unknown>, body: (match[2] ?? "").trim() };
    }
  }
}

function strings(value: unknown, what: string): string[] {
  if (value === undefined) {
    return [];
  } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  } else {
    throw new Error(`${what} must be a list of names`);
  }
}

/** One profile directory; throws with the reason when it is not a valid profile. */
export function readProfile(dir: string, source: SubagentProfile["source"]): SubagentProfile {
  const { data, body } = frontmatter(readFileSync(join(dir, "SUBAGENT.md"), "utf8"));
  const skillPath = join(dir, "SKILL.md");
  const { name, description, engine, model, mode = "inherit", tools = {}, background = false, notify = "wake", subagents } = data;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error("name must be lowercase letters, digits and dashes");
  } else if (typeof description !== "string" || description.trim() === "") {
    throw new Error("description is required");
  } else if (engine !== "harness" && engine !== "claude") {
    throw new Error("engine must be harness or claude");
  } else if (model !== undefined && (typeof model !== "string" || !model.includes("/"))) {
    throw new Error('model must be a model reference like "anthropic/opus:medium"');
  } else if (engine === "claude" && typeof model === "string" && model.includes(":") && !(CLAUDE_EFFORTS as readonly string[]).includes(model.split(":")[1] ?? "")) {
    throw new Error(`the claude engine takes the thinking levels ${CLAUDE_EFFORTS.join(", ")}`);
  } else if (mode !== "plan" && mode !== "build" && mode !== "simple" && mode !== "inherit") {
    throw new Error("mode must be plan, build, simple or inherit");
  } else if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new Error("tools must be a mapping with allow and deny");
  } else if (typeof background !== "boolean") {
    throw new Error("background must be true or false");
  } else if (!isNotifyPolicy(notify)) {
    throw new Error("notify must be wake, queue or none");
  } else if (body === "") {
    throw new Error("the role (the body after the frontmatter) is empty");
  } else if (!existsSync(skillPath)) {
    throw new Error("SKILL.md (the briefing for the calling model) is missing");
  } else {
    const { allow, deny } = tools as { allow?: unknown; deny?: unknown };
    return {
      name,
      description,
      engine,
      ...(typeof model === "string" ? { model } : {}),
      mode,
      tools: { ...(allow !== undefined ? { allow: strings(allow, "tools.allow") } : {}), ...(deny !== undefined ? { deny: strings(deny, "tools.deny") } : {}) },
      background,
      notify,
      subagents: strings(subagents, "subagents"),
      role: body,
      skillPath,
      source,
      dir,
    };
  }
}

function readSource(root: string, source: SubagentProfile["source"], into: Map<string, SubagentProfile>, problems: string[]): void {
  if (!existsSync(root)) {
    return;
  } else {
    for (const entry of readdirSync(root, { withFileTypes: true }).filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(root, entry.name);
      try {
        const profile = readProfile(dir, source);
        if (profile.name !== entry.name) {
          problems.push(`${dir}: the directory must be named after the profile (${profile.name})`);
        } else if (!into.has(profile.name)) {
          into.set(profile.name, profile);
        } else {
          // an earlier source has this name
        }
      } catch (error) {
        problems.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** Profiles whose `subagents` name a missing profile or close a cycle are left out. */
function checkReferences(profiles: Map<string, SubagentProfile>, problems: string[]): void {
  removeCycles(profiles, problems);
  let changed = true;
  while (changed) {
    changed = false;
    for (const profile of [...profiles.values()]) {
      const missing = profile.subagents.filter((name) => !profiles.has(name));
      if (missing.length > 0) {
        problems.push(`${profile.dir}: subagents names unknown profiles: ${missing.join(", ")}`);
        profiles.delete(profile.name);
        changed = true;
      } else {
        // every name exists (for now)
      }
    }
  }
}

/** Every profile on a cycle of `subagents` is left out (all of them at once, so none survives half a cycle). */
function removeCycles(profiles: Map<string, SubagentProfile>, problems: string[]): void {
  const cycle = (name: string, path: string[]): string[] | undefined => {
    if (path.includes(name)) {
      return [...path, name];
    } else {
      for (const next of profiles.get(name)?.subagents ?? []) {
        const found = cycle(next, [...path, name]);
        if (found !== undefined) {
          return found;
        } else {
          // no cycle this way
        }
      }
      return undefined;
    }
  };
  const onCycle = [...profiles.values()].map((profile) => ({ profile, found: cycle(profile.name, []) })).filter(({ found }) => found !== undefined && found[0] === found.at(-1));
  for (const { profile, found } of onCycle) {
    problems.push(`${profile.dir}: subagents form a cycle: ${(found ?? []).join(" → ")}`);
  }
  for (const { profile } of onCycle) {
    profiles.delete(profile.name);
  }
}

export function loadRegistry(options: { cwd: string; dataDir: string; projectTrusted: boolean; bundledDir?: string }): Registry {
  const profiles = new Map<string, SubagentProfile>();
  const problems: string[] = [];
  if (options.projectTrusted) {
    readSource(join(options.cwd, ".harness", "subagents"), "project", profiles, problems);
  } else {
    // an untrusted project's profiles are not read
  }
  readSource(join(options.dataDir, "subagents"), "user", profiles, problems);
  readSource(options.bundledDir ?? BUNDLED_DIR, "bundle", profiles, problems);
  checkReferences(profiles, problems);
  return { profiles, problems };
}

/** Whether a tool name matches a name or a mask with `*`. */
export function matchesTool(name: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return regex.test(name);
}

/**
 * Whether a subagent may use a tool: `ctx_*` never; `subagent` only with profiles to call below the
 * depth limit; otherwise allowed when it matches `allow` (all when absent) and no `deny`.
 */
export function toolAllowed(name: string, launch: { tools: { allow?: string[]; deny?: string[] }; subagents: string[]; depth: number }, maxDepth: number): boolean {
  if (matchesTool(name, "ctx_*")) {
    return false;
  } else if (name === "subagent") {
    return launch.subagents.length > 0 && launch.depth < maxDepth;
  } else if (launch.tools.deny?.some((pattern) => matchesTool(name, pattern)) === true) {
    return false;
  } else {
    return launch.tools.allow === undefined || launch.tools.allow.some((pattern) => matchesTool(name, pattern));
  }
}
