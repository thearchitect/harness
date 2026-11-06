/**
 * project_tree: a project's layout in one call, as byte-sorted paths. By
 * default the whole directory tree, each directory with the number of files
 * directly in it and the first line of its .dirinfo.md, plus the files of the
 * listed directory itself (manifests, entry points); with files: true every
 * file. Ignored entries are left out the way fd and ripgrep leave them out.
 *
 * Ignore rules, by precedence: .ignore files, then .gitignore files, then the
 * repository's info/exclude. Within each kind the deepest file that decides
 * wins, within a file the last matching pattern; and, as in git, whatever lies
 * inside a directory a kind ignores stays ignored by that kind (re-including
 * build/ through .ignore shows the directory; !build/** shows its contents).
 * .gitignore and info/exclude apply only inside a git repository, from its
 * root (a nested repository starts its own). The rule files above the listed
 * directory count from the repository root, outside git from the listed
 * directory itself; a directory listed explicitly although those rules ignore
 * it (node_modules/x) is listed with the rule files from itself down. Global
 * git excludes are not read: a project's rules live in the project.
 *
 * Never listed: .git, harness session workspaces, .dirinfo.md itself (its
 * line stands next to the directory), symlinks and special files.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { AGENT_WORKSPACE_DIR } from "./lsp/index.ts";

const DIRINFO = ".dirinfo.md";
const NEVER_LISTED = new Set([".git", AGENT_WORKSPACE_DIR]);

type Matcher = { base: string; rules: ReturnType<typeof ignore> };

/** The ignore rules in force inside one directory; matchers outermost first. */
type Rules = {
  inGit: boolean;
  ignoreFiles: readonly Matcher[];
  gitignores: readonly Matcher[];
  exclude: Matcher | undefined;
};

const NO_RULES: Rules = { inGit: false, ignoreFiles: [], gitignores: [], exclude: undefined };

export type TreeOptions = {
  /** List every file, not only the listed directory's own. */
  files: boolean;
  signal?: AbortSignal;
};

/** A listed entry's lines (unsorted) and whether it is a file counted in its parent's line. */
type Listed = { lines: string[]; file: boolean };

export function registerProjectTree(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_tree",
    label: "Project tree",
    description: [
      "The whole directory tree of a project in one call, as sorted paths, one per line: every directory, ending with /, with the number of files directly in it and the first line of its .dirinfo.md after \" - \", plus the files of the listed directory itself (manifests, entry points). The first line is the listed directory.",
      "Use it in two steps: first without arguments, the full tree of the project, to see its modules and decide where to look; then, only where you need the files, path with files: true for each such directory, which lists every file of that subtree.",
      "Paths start with path as given (relative to the cwd when path is omitted), so they go straight to read.",
      "Leaves out what .ignore, .gitignore and the repository's info/exclude ignore (global git excludes are not read), plus .git and session workspaces; hidden entries are listed, symlinks are not. Unreadable directories and rule files are marked in place, never skipped silently.",
    ].join(" "),
    promptSnippet: "The whole directory tree of a project in one call, with file counts and .dirinfo.md descriptions; files of chosen subtrees on request",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list, relative to the cwd or absolute (default: the cwd, the whole project)" })),
      files: Type.Optional(Type.Boolean({ description: "List every file of the tree (default: directories with file counts, plus the files of the listed directory itself)" })),
    }),
    executionMode: "parallel",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const lines = await projectTree(resolve(ctx.cwd, params.path ?? "."), params.path, { files: params.files ?? false, signal });
      return { content: [{ type: "text", text: renderProjectTree(lines) }], details: undefined };
    },
  });
}

/**
 * The listing of `root`, sorted, its first line the root itself. `shownAs` is
 * the path as the caller gave it: the prefix of every listed path (undefined
 * or ".": paths relative to the root).
 */
export async function projectTree(root: string, shownAs: string | undefined, options: TreeOptions): Promise<string[]> {
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error(`${root} is not a directory`);
  } else {
    const shown = shownAs === undefined ? "." : shownAs.replace(/\/+$/, "") || "/";
    const prefix = shown === "." ? "" : shown === "/" ? "/" : `${shown}/`;
    const problems: string[] = [];
    const rules = await rulesAt(root, problems);
    const [header, ...entries] = await directoryLines(root, shown === "/" ? "" : shown, prefix, rules, problems, true, options);
    return [header!, ...entries.sort(byBytes)];
  }
}

/** The listing as the tool returns it: cut to pi's output limits, with a notice when cut. */
export function renderProjectTree(lines: readonly string[]): string {
  const truncation = truncateHead(lines.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (truncation.truncated) {
    return `${truncation.content}\n\n[Truncated: ${truncation.outputLines} of ${truncation.totalLines} lines shown; list the remaining directories' files with path and files: true]`;
  } else {
    return truncation.content;
  }
}

/** Byte order of the paths (LC_ALL=C sort); a directory's trailing / keeps its entries right after it. */
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * The rules in force inside `root`: the rule files from the enclosing
 * repository's root (outside git, from `root` itself) down to `root`. A
 * directory on the way that the rules above it ignore drops them: what is
 * listed explicitly is listed, under its own rule files.
 */
async function rulesAt(root: string, problems: string[]): Promise<Rules> {
  // root and its ancestors up to the repository root, innermost first
  const chain = [root];
  for (let dir = root; ; dir = dirname(dir)) {
    if ((await noted(".git", problems, () => gitDirOf(dir))) !== undefined) {
      break;
    } else if (dirname(dir) === dir) {
      // outside git: the rule files of root alone
      chain.splice(1);
      break;
    } else {
      chain.push(dirname(dir));
    }
  }
  let rules = NO_RULES;
  for (const dir of chain.reverse()) {
    const outer = isIgnored(rules, dir, true) ? { ...NO_RULES, inGit: rules.inGit } : rules;
    rules = await enterDirectory(dir, outer, problems);
  }
  return rules;
}

/** The rules in force inside `dir`, given those of its parent: a repository root restarts the git rules. */
async function enterDirectory(dir: string, outer: Rules, problems: string[]): Promise<Rules> {
  const gitDir = await noted(".git", problems, () => gitDirOf(dir));
  let rules: Rules;
  if (gitDir === undefined) {
    rules = outer;
  } else {
    const exclude = await noted("info/exclude", problems, async () => readRules(await excludeFileOf(gitDir)));
    rules = { ...outer, inGit: true, gitignores: [], exclude: exclude === undefined ? undefined : { base: dir, rules: exclude } };
  }
  const gitignore = rules.inGit ? await noted(".gitignore", problems, () => readRules(join(dir, ".gitignore"))) : undefined;
  const ignoreFile = await noted(".ignore", problems, () => readRules(join(dir, ".ignore")));
  return {
    ...rules,
    gitignores: gitignore === undefined ? rules.gitignores : [...rules.gitignores, { base: dir, rules: gitignore }],
    ignoreFiles: ignoreFile === undefined ? rules.ignoreFiles : [...rules.ignoreFiles, { base: dir, rules: ignoreFile }],
  };
}

/**
 * A directory's line followed by the lines of its entries (unsorted). Its
 * files are listed with files: true and for the listed directory itself;
 * otherwise the line counts them.
 */
async function directoryLines(
  dir: string,
  shown: string,
  prefix: string,
  rules: Rules,
  problems: string[],
  isRoot: boolean,
  options: TreeOptions,
): Promise<string[]> {
  options.signal?.throwIfAborted();
  const info = await noted(DIRINFO, problems, () => firstLine(join(dir, DIRINFO)));
  const dirents = await noted("listing", problems, () => readdir(dir, { withFileTypes: true }));
  const listFiles = options.files || isRoot;
  const entries = await Promise.all((dirents ?? []).map((dirent) => entryLines(dirent, dir, prefix, rules, listFiles, options)));
  const files = entries.filter((entry) => entry.file).length;
  const count = listFiles || files === 0 ? "" : ` (${files} ${files === 1 ? "file" : "files"})`;
  const description = info === undefined || info === "" ? "" : ` - ${info}`;
  const marks = problems.length === 0 ? "" : ` (unreadable: ${[...new Set(problems)].join("; ")})`;
  return [`${shown}/${count}${description}${marks}`, ...entries.flatMap((entry) => entry.lines)];
}

async function entryLines(dirent: Dirent, parent: string, prefix: string, rules: Rules, listFiles: boolean, options: TreeOptions): Promise<Listed> {
  const path = join(parent, dirent.name);
  const shown = prefix + dirent.name;
  if (NEVER_LISTED.has(dirent.name)) {
    return { lines: [], file: false };
  } else if (dirent.isDirectory()) {
    if (isIgnored(rules, path, true)) {
      return { lines: [], file: false };
    } else {
      const problems: string[] = [];
      const inner = await enterDirectory(path, rules, problems);
      return { lines: await directoryLines(path, shown, `${shown}/`, inner, problems, false, options), file: false };
    }
  } else if (dirent.isFile()) {
    if (dirent.name === DIRINFO || isIgnored(rules, path, false)) {
      return { lines: [], file: false };
    } else {
      return { lines: listFiles ? [shown] : [], file: true };
    }
  } else {
    // symlinks, sockets, fifos and devices are not listed (as fd --type d/f)
    return { lines: [], file: false };
  }
}

function isIgnored(rules: Rules, path: string, directory: boolean): boolean {
  return (
    decide(rules.ignoreFiles, path, directory) ??
    decide(rules.gitignores, path, directory) ??
    decide(rules.exclude === undefined ? [] : [rules.exclude], path, directory) ??
    false
  );
}

/** The verdict of the deepest matcher that decides about `path`; undefined when none does. */
function decide(matchers: readonly Matcher[], path: string, directory: boolean): boolean | undefined {
  for (let index = matchers.length - 1; index >= 0; index--) {
    const { base, rules } = matchers[index]!;
    const verdict = rules.test(relative(base, path) + (directory ? "/" : ""));
    if (verdict.ignored) {
      return true;
    } else if (verdict.unignored) {
      return false;
    } else {
      // this file has no rule for the path: the next outer one decides
    }
  }
  return undefined;
}

/**
 * Runs a read that returns undefined for an absent file; any other failure
 * becomes a mark on the directory ("what: CODE") instead of failing the listing.
 */
async function noted<T>(what: string, problems: string[], read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    problems.push(`${what}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    return undefined;
  }
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isAbsent(error)) {
      return undefined;
    } else {
      throw error;
    }
  }
}

async function readRules(file: string): Promise<Matcher["rules"] | undefined> {
  const text = await readOptional(file);
  return text === undefined ? undefined : ignore().add(text);
}

async function firstLine(file: string): Promise<string | undefined> {
  const text = await readOptional(file);
  return text === undefined ? undefined : text.split("\n", 1)[0]!.replace(/\r$/, "").trim();
}

/** The git directory of a repository rooted at `dir`: its .git directory, or the target of a .git file (worktrees, submodules). */
async function gitDirOf(dir: string): Promise<string | undefined> {
  const dotGit = join(dir, ".git");
  let info;
  try {
    info = await lstat(dotGit);
  } catch (error) {
    if (isAbsent(error)) {
      return undefined;
    } else {
      throw error;
    }
  }
  if (info.isDirectory()) {
    return dotGit;
  } else if (info.isFile()) {
    const target = /^gitdir: (.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
    if (target === undefined) {
      throw new Error(`${dotGit} names no gitdir`);
    } else {
      return resolve(dir, target);
    }
  } else {
    // a symlink or special file named .git: not a repository
    return undefined;
  }
}

/** info/exclude of a git directory; a linked worktree shares its main repository's (commondir). */
async function excludeFileOf(gitDir: string): Promise<string> {
  const commonDir = (await readOptional(join(gitDir, "commondir")))?.trim();
  return join(commonDir === undefined ? gitDir : resolve(gitDir, commonDir), "info", "exclude");
}
