/**
 * Go: gopls of the bundle, with the project's own `go` from PATH.
 *
 * gopls answers references, rename and implementations inside one build:
 * the modules of one workspace and one set of build tags. The driver makes
 * that build the whole repository:
 *
 *   modules  every `use` of the repository's go.work (paths outside the
 *            repository included), the local targets of their replace
 *            directives, and every go.mod in the tree, skipping the
 *            directories the go command ignores (testdata, vendor, _*, .*);
 *            of a module path declared twice the first in that order stays
 *            and the duplicate is reported. They go into a generated go.work
 *            (GOWORK) that keeps the repository's go.work directives;
 *   tags     the union of user-defined build tags of all `//go:build` lines.
 *
 * A change of the module set or of the tags reaches gopls through
 * `workspace/didChangeConfiguration`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DriverEnv, LanguageDriver, LanguageProfile, ServerLink, SyncOutcome, WorkspaceSummary } from "../profile.ts";
import type { SnapshotDiff } from "../snapshot.ts";

const execFileAsync = promisify(execFile);

const MODULE_FILES = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"]);
/** GOOS and GOARCH values, release and compiler tags: everything in a build line that is not user-defined. */
const PREDEFINED_TAGS = new Set([
  ...["aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "nacl", "netbsd", "openbsd", "plan9", "solaris", "wasip1", "windows", "zos", "unix"],
  ...["386", "amd64", "amd64p32", "arm", "armbe", "arm64", "arm64be", "loong64", "mips", "mipsle", "mips64", "mips64le", "mips64p32", "mips64p32le", "ppc", "ppc64", "ppc64le", "riscv", "riscv64", "s390", "s390x", "sparc", "sparc64", "wasm"],
  ...["cgo", "gc", "gccgo", "ignore", "purego", "boringcrypto", "goexperiment"],
]);
const BUILD_LINE_BYTES = 16_384;

/** A module; localReplaces: directories its go.mod replaces dependencies with. */
type Module = { dir: string; path: string; go: string | undefined; localReplaces: string[] };
type Model = {
  modules: Module[];
  excluded: { dir: string; reason: string }[];
  tags: string[];
  /** The generated go.work: a new file for every new content, so gopls sees the change as a new GOWORK. */
  goWork: { path: string; text: string } | undefined;
  /** The repository's own go.work (often gitignored, so read from disk, not from the file list) and its stamp. */
  repoGoWork: string | undefined;
  repoGoWorkStamp: string;
};
type GoWorkJson = {
  Go?: string;
  Toolchain?: string;
  Godebug?: { Key: string; Value: string }[];
  Use?: { DiskPath: string }[];
  Replace?: { Old: { Path: string; Version?: string }; New: { Path: string; Version?: string } }[];
};

export const goProfile: LanguageProfile = {
  id: "go",
  name: "Go",
  extensions: [".go"],
  moves: "same-directory",
  languageId() {
    return "go";
  },
  significant(file) {
    return file.endsWith(".go") || MODULE_FILES.has(basename(file));
  },
  createDriver(env) {
    return new GoDriver(env);
  },
};

class GoDriver implements LanguageDriver {
  private readonly env: DriverEnv;
  private model: Model | undefined;
  /** Build tags of each Go file with a `//go:build` line. */
  private readonly fileTags = new Map<string, string[]>();
  private readonly moduleCache = new Map<string, { stamp: string; module: Module }>();
  private generation = 0;

  constructor(env: DriverEnv) {
    this.env = env;
  }

  async prepare(files: readonly string[]): Promise<void> {
    try {
      await execFileAsync("go", ["env", "GOVERSION"]);
    } catch (error) {
      throw new Error(`the Go toolchain (go) is not available in PATH; gopls needs the project's toolchain (${error instanceof Error ? error.message : String(error)})`);
    }
    await this.scanTags(files.filter((file) => file.endsWith(".go")), []);
    this.model = await this.discover(files);
  }

  launch() {
    return { command: this.env.toolchain.gopls, args: ["serve"], env: process.env, cwd: this.env.root };
  }

  initializationOptions(): unknown {
    return this.settings();
  }

  capabilities(): Record<string, unknown> {
    return {};
  }

  configuration(section: string | undefined): unknown {
    if (section === "gopls") {
      return this.settings();
    } else {
      return null;
    }
  }

  async initialized(): Promise<void> {
    // settings travel with initialize
  }

  async sync(server: ServerLink, files: readonly string[], diff: SnapshotDiff, first: boolean): Promise<SyncOutcome> {
    if (first) {
      return "current";
    } else {
      const goFiles = (list: string[]): string[] => list.filter((file) => file.endsWith(".go"));
      await this.scanTags([...goFiles(diff.created), ...goFiles(diff.changed)], goFiles(diff.deleted));
      const touched = [...diff.created, ...diff.changed, ...diff.deleted];
      const modulesTouched =
        touched.some((file) => MODULE_FILES.has(basename(file))) ||
        (await fileStamp(join(this.env.root, "go.work"))) !== this.model?.repoGoWorkStamp;
      const tags = this.tagUnion();
      const previous = this.model;
      if (previous !== undefined && !modulesTouched && sameList(previous.tags, tags)) {
        return "current";
      } else {
        const next = await this.discover(files);
        this.model = next;
        if (previous !== undefined && previous.goWork?.path === next.goWork?.path && sameList(previous.tags, next.tags)) {
          // the build gopls already has
        } else {
          server.notify("workspace/didChangeConfiguration", { settings: { gopls: this.settings() } });
        }
        return "current";
      }
    }
  }

  async ready(): Promise<void> {
    // gopls loads packages on demand within each request
  }

  notification(): void {
    // nothing to track
  }

  summary(): WorkspaceSummary {
    const model = this.model;
    if (model === undefined) {
      return { lines: ["Go: not synchronized yet"], facts: {} };
    } else {
      const show = (dir: string): string => {
        const inside = relative(this.env.root, dir);
        return inside === "" ? "." : inside.startsWith("..") ? dir : inside;
      };
      return {
        lines: [
          `Go: ${model.modules.length} modules in one workspace${model.repoGoWork !== undefined ? " (the repository's go.work plus every go.mod in the tree)" : " (every go.mod in the tree)"}; build tags: ${model.tags.length > 0 ? model.tags.join(",") : "none"}`,
          ...model.modules.map((module) => `  module ${module.path} (${show(module.dir)})`),
          ...model.excluded.map((entry) => `  excluded ${show(entry.dir)}: ${entry.reason}`),
          "  not analyzed: files excluded by negated build tags (!tag) or by another GOOS/GOARCH",
        ],
        facts: {
          modules: model.modules.map((module) => ({ path: module.path, dir: show(module.dir) })),
          excluded: model.excluded.map((entry) => ({ dir: show(entry.dir), reason: entry.reason })),
          buildTags: model.tags,
        },
      };
    }
  }

  async dispose(): Promise<void> {
    // the generated go.work lives in the session's temp dir
  }

  private settings(): Record<string, unknown> {
    const model = this.model;
    const settings: Record<string, unknown> = {};
    if (model !== undefined && model.goWork !== undefined) {
      settings.env = { GOWORK: model.goWork.path };
    } else {
      // no modules: gopls' defaults
    }
    if (model !== undefined && model.tags.length > 0) {
      settings.buildFlags = [`-tags=${model.tags.join(",")}`];
    } else {
      // no user-defined tags
    }
    return settings;
  }

  private tagUnion(): string[] {
    return [...new Set([...this.fileTags.values()].flat())].sort();
  }

  private async scanTags(files: readonly string[], deleted: readonly string[]): Promise<void> {
    for (const file of deleted) {
      this.fileTags.delete(file);
    }
    await Promise.all(
      files.map(async (file) => {
        const tags = await buildTags(file);
        if (tags.length > 0) {
          this.fileTags.set(file, tags);
        } else {
          this.fileTags.delete(file);
        }
      }),
    );
  }

  private async discover(files: readonly string[]): Promise<Model> {
    const root = this.env.root;
    const repoGoWorkPath = join(root, "go.work");
    const repoGoWorkStamp = await fileStamp(repoGoWorkPath);
    const repoGoWork = repoGoWorkStamp !== "absent" ? repoGoWorkPath : undefined;
    let work: GoWorkJson = {};
    if (repoGoWork !== undefined) {
      work = JSON.parse((await execFileAsync("go", ["work", "edit", "-json", repoGoWork], { cwd: root })).stdout) as GoWorkJson;
    } else {
      // no go.work of the repository
    }
    // Precedence for a module path declared twice: the go.work modules, then
    // the local targets of their replace directives (transitively) - the
    // copies the build actually uses - then the rest of the tree in path order.
    const tree = files
      .filter((file) => basename(file) === "go.mod" && !ignoredByGo(relative(root, dirname(file))))
      .map((file) => dirname(file))
      .sort();
    const queue: string[] = (work.Use ?? []).map((use) => resolve(root, use.DiskPath));
    const modules: Module[] = [];
    const excluded: Model["excluded"] = [];
    const byPath = new Map<string, Module>();
    const byDir = new Set<string>();
    const admit = async (dir: string): Promise<void> => {
      if (byDir.has(dir)) {
        // already considered
      } else {
        byDir.add(dir);
        const module = await this.readModule(dir);
        const taken = byPath.get(module.path);
        if (taken !== undefined) {
          excluded.push({ dir, reason: `module path ${module.path} is already provided by ${taken.dir}` });
        } else {
          byPath.set(module.path, module);
          modules.push(module);
          queue.push(...module.localReplaces);
        }
      }
    };
    while (queue.length > 0) {
      await admit(queue.shift()!);
    }
    for (const dir of tree) {
      await admit(dir);
      while (queue.length > 0) {
        await admit(queue.shift()!);
      }
    }
    const tags = this.tagUnion();
    if (modules.length === 0) {
      return { modules, excluded, tags, goWork: undefined, repoGoWork, repoGoWorkStamp };
    } else {
      const text = renderGoWork(work, modules, root);
      const previous = this.model?.goWork;
      if (previous !== undefined && previous.text === text) {
        return { modules, excluded, tags, goWork: previous, repoGoWork, repoGoWorkStamp };
      } else {
        this.generation += 1;
        const dir = join(this.env.tempDir, `gen-${this.generation}`);
        await mkdir(dir, { recursive: true });
        const path = join(dir, "go.work");
        await writeFile(path, text, "utf8");
        return { modules, excluded, tags, goWork: { path, text }, repoGoWork, repoGoWorkStamp };
      }
    }
  }

  private async readModule(dir: string): Promise<Module> {
    const goMod = join(dir, "go.mod");
    let stamp: string;
    try {
      const info = await stat(goMod, { bigint: true });
      stamp = `${info.mtimeNs}:${info.size}`;
    } catch {
      throw new Error(`go.work uses ${dir}, which has no go.mod`);
    }
    const cached = this.moduleCache.get(dir);
    if (cached !== undefined && cached.stamp === stamp) {
      return cached.module;
    } else {
      let parsed: { Module?: { Path?: string }; Go?: string; Replace?: { New: { Path: string; Version?: string } }[] };
      try {
        parsed = JSON.parse((await execFileAsync("go", ["mod", "edit", "-json", goMod], { cwd: dir })).stdout);
      } catch (error) {
        throw new Error(`cannot read ${goMod}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed.Module?.Path === undefined) {
        throw new Error(`${goMod} declares no module path`);
      } else {
        const localReplaces = (parsed.Replace ?? [])
          .filter((replace) => replace.New.Version === undefined)
          .map((replace) => resolve(dir, replace.New.Path))
          .filter((target) => existsSync(join(target, "go.mod")));
        const module = { dir, path: parsed.Module.Path, go: parsed.Go, localReplaces };
        this.moduleCache.set(dir, { stamp, module });
        return module;
      }
    }
  }
}

/** The go command skips testdata, vendor and directories starting with _ or . */
function ignoredByGo(relativeDir: string): boolean {
  return relativeDir
    .split(sep)
    .some((segment) => segment === "testdata" || segment === "vendor" || segment.startsWith("_") || (segment.startsWith(".") && segment !== "."));
}

function renderGoWork(work: GoWorkJson, modules: readonly Module[], root: string): string {
  const versions = [work.Go, ...modules.map((module) => module.go)].filter((version): version is string => version !== undefined);
  const lines: string[] = [];
  if (versions.length > 0) {
    lines.push(`go ${versions.reduce((max, version) => (compareGoVersions(version, max) > 0 ? version : max))}`);
  } else {
    // no version anywhere: the go command's default
  }
  if (work.Toolchain !== undefined) {
    lines.push(`toolchain ${work.Toolchain}`);
  } else {
    // no toolchain directive
  }
  for (const entry of work.Godebug ?? []) {
    lines.push(`godebug ${entry.Key}=${entry.Value}`);
  }
  lines.push("use (", ...modules.map((module) => `\t${quote(module.dir)}`), ")");
  for (const replace of work.Replace ?? []) {
    const oldPart = replace.Old.Version !== undefined ? `${replace.Old.Path} ${replace.Old.Version}` : replace.Old.Path;
    const local = replace.New.Version === undefined && (replace.New.Path.startsWith(".") || isAbsolute(replace.New.Path));
    const newPath = local ? resolve(root, replace.New.Path) : replace.New.Path;
    const newPart = replace.New.Version !== undefined ? `${newPath} ${replace.New.Version}` : quote(newPath);
    lines.push(`replace ${oldPart} => ${newPart}`);
  }
  return `${lines.join("\n")}\n`;
}

function quote(path: string): string {
  return /[\s"]/.test(path) ? JSON.stringify(path) : path;
}

/** Orders Go versions such as 1.26, 1.26.5, 1.27rc1 numerically. */
export function compareGoVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.split(/[.a-z]+/).filter(Boolean).map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference !== 0) {
      return difference;
    } else {
      // equal so far
    }
  }
  return 0;
}

/** User-defined tags of a file's `//go:build` line, read from the file header. */
export async function buildTags(file: string): Promise<string[]> {
  let header: string;
  {
    const handle = await open(file, "r").catch(() => undefined);
    if (handle === undefined) {
      return [];
    } else {
      try {
        const buffer = Buffer.alloc(BUILD_LINE_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, BUILD_LINE_BYTES, 0);
        header = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
  }
  return parseBuildTags(header);
}

export function parseBuildTags(header: string): string[] {
  const tags = new Set<string>();
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("package ")) {
      break;
    } else if (trimmed.startsWith("//go:build ")) {
      for (const token of trimmed.slice("//go:build ".length).match(/[A-Za-z0-9_.]+/g) ?? []) {
        if (!PREDEFINED_TAGS.has(token) && !/^go1(\.\d+)?$/.test(token)) {
          tags.add(token);
        } else {
          // GOOS, GOARCH, release or compiler tag
        }
      }
    } else {
      // comments and blank lines of the header
    }
  }
  return [...tags];
}

async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.mtimeNs}:${info.size}`;
  } catch {
    return "absent";
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
