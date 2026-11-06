/**
 * The workspace of a pi session: the repository that holds its working
 * directory, and one language session per language, started on first use.
 */

import { extname, relative, isAbsolute, resolve } from "node:path";
import type { LanguageProfile, Toolchain } from "./profile.ts";
import { goProfile } from "./profiles/go.ts";
import { rustProfile } from "./profiles/rust.ts";
import { typescriptProfile } from "./profiles/ts.ts";
import { LanguageSession, type SessionStatus } from "./session.ts";
import { listFiles, repositoryRoot } from "./snapshot.ts";

export const PROFILES: readonly LanguageProfile[] = [typescriptProfile, goProfile, rustProfile];

const PROFILE_BY_EXTENSION = new Map(PROFILES.flatMap((profile) => profile.extensions.map((ext) => [ext, profile] as const)));

export class Workspace {
  /** The coverage boundary: the repository root (the superproject of a submodule), or the cwd outside git. */
  readonly root: string;
  readonly inGit: boolean;
  /** The session's cwd: tool paths are relative to it, as for every other tool. */
  readonly cwd: string;
  private readonly toolchain: Toolchain;
  private readonly sessions = new Map<string, LanguageSession>();
  private closed = false;

  private constructor(root: string, inGit: boolean, cwd: string, toolchain: Toolchain) {
    this.root = root;
    this.inGit = inGit;
    this.cwd = cwd;
    this.toolchain = toolchain;
  }

  /** The workspace of `cwd`: its repository (the superproject of a submodule), or `cwd` itself outside git. */
  static async open(cwd: string, toolchain: Toolchain): Promise<Workspace> {
    const root = await repositoryRoot(cwd);
    if (root !== undefined) {
      return new Workspace(root, true, resolve(cwd), toolchain);
    } else {
      return new Workspace(resolve(cwd), false, resolve(cwd), toolchain);
    }
  }

  /** Whether an absolute path lies inside the workspace (the root itself excluded). */
  contains(path: string): boolean {
    const inside = relative(this.root, path);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  }

  /** Absolute path of a tool argument (relative to the cwd, or absolute), which must lie inside the workspace. */
  resolvePath(path: string): string {
    const absolute = resolve(this.cwd, path);
    if (this.contains(absolute)) {
      return absolute;
    } else {
      throw new Error(`${path} is outside the workspace ${this.root}`);
    }
  }

  /** Path for display: relative to the cwd inside the workspace, absolute outside it. */
  display(path: string): string {
    if (this.contains(path)) {
      return relative(this.cwd, path) || ".";
    } else {
      return path;
    }
  }

  /** The language of a file; undefined when no language server handles it. */
  profileOf(file: string): LanguageProfile | undefined {
    return PROFILE_BY_EXTENSION.get(extname(file));
  }

  profileFor(file: string): LanguageProfile {
    const profile = this.profileOf(file);
    if (profile !== undefined) {
      return profile;
    } else {
      throw new Error(
        `${this.display(file)}: no language server for "${extname(file) || "(no extension)"}" files; supported: ${[...PROFILE_BY_EXTENSION.keys()].join(" ")}`,
      );
    }
  }

  session(profile: LanguageProfile): LanguageSession {
    if (this.closed) {
      throw new Error("the workspace is closed with the session");
    } else {
      const existing = this.sessions.get(profile.id);
      if (existing !== undefined) {
        return existing;
      } else {
        const created = new LanguageSession(profile, { root: this.root, inGit: this.inGit, toolchain: this.toolchain });
        this.sessions.set(profile.id, created);
        return created;
      }
    }
  }

  /** Languages with at least one source file in the workspace. */
  async presentProfiles(): Promise<LanguageProfile[]> {
    const files = await listFiles(this.root, this.inGit);
    const extensions = new Set(files.map((file) => extname(file)));
    return PROFILES.filter((profile) => profile.extensions.some((ext) => extensions.has(ext)));
  }

  statuses(): SessionStatus[] {
    return [...this.sessions.values()].map((session) => session.status());
  }

  async restart(language: string | undefined): Promise<string[]> {
    const targets = [...this.sessions.values()].filter((session) => language === undefined || session.profile.id === language);
    await Promise.all(targets.map((session) => session.restart()));
    return targets.map((session) => session.profile.name);
  }

  /** Stops every server. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
  }
}
