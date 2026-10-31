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
  readonly root: string;
  readonly inGit: boolean;
  private readonly toolchain: Toolchain;
  private readonly sessions = new Map<string, LanguageSession>();
  private closed = false;

  private constructor(root: string, inGit: boolean, toolchain: Toolchain) {
    this.root = root;
    this.inGit = inGit;
    this.toolchain = toolchain;
  }

  /** The workspace of `cwd`: its repository (the superproject of a submodule), or `cwd` itself outside git. */
  static async open(cwd: string, toolchain: Toolchain): Promise<Workspace> {
    const root = await repositoryRoot(cwd);
    if (root !== undefined) {
      return new Workspace(root, true, toolchain);
    } else {
      return new Workspace(resolve(cwd), false, toolchain);
    }
  }

  /** Absolute path of a tool argument, which must lie inside the workspace. */
  resolvePath(path: string): string {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    const inside = relative(this.root, absolute);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${path} is outside the workspace ${this.root}`);
    } else {
      return absolute;
    }
  }

  /** Path for display: relative inside the workspace, absolute outside it. */
  display(path: string): string {
    const inside = relative(this.root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return path;
    } else {
      return inside;
    }
  }

  profileFor(file: string): LanguageProfile {
    const profile = PROFILE_BY_EXTENSION.get(extname(file));
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
