// Files the operator hands to sessions (pasted images, dropped and picked files): kept by the hub
// with the session, by content — ~/.harness/attachments/<session>/<sha256>.<ext> — never in a
// temporary directory, so a draft that names one keeps it across restarts and devices. One that
// neither a draft nor its session's transcript names goes after `attachments.retentionDays` (7).

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const ATTACHMENTS_RETENTION_DAYS = 7;

export class Attachments {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "attachments");
  }

  /** Keeps a file for a session; the same content is one file. */
  async put(session: string, name: string, bytes: Buffer): Promise<string> {
    const safeSession = session.replace(/[^\w-]/g, "_");
    const extension = extname(name).replace(/[^\w.]/g, "").slice(0, 16);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const dir = join(this.dir, safeSession);
    const path = join(dir, `${hash}${extension}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path, bytes, { flag: "w" });
    return path;
  }

  /**
   * Removes what nothing names any more: files older than `days` that no draft and no transcript
   * of their session (`sessionText`, undefined when it has none on disk) mentions.
   */
  async sweep(days: number, now: number, drafts: string[], sessionText: (session: string) => Promise<string | undefined>): Promise<string[]> {
    const removed: string[] = [];
    const sessions = await readdir(this.dir).catch(() => [] as string[]);
    for (const session of sessions) {
      const dir = join(this.dir, session);
      const files = await readdir(dir).catch(() => [] as string[]);
      const transcript = files.length > 0 ? await sessionText(session) : undefined;
      for (const file of files) {
        const path = join(dir, file);
        const { mtimeMs } = await stat(path);
        const named = drafts.some((text) => text.includes(path)) || (transcript?.includes(path) ?? false);
        if (!named && now - mtimeMs > days * 24 * 3600 * 1000) {
          await rm(path, { force: true });
          removed.push(path);
        } else {
          // named, or still young
        }
      }
      if ((await readdir(dir).catch(() => [] as string[])).length === 0) {
        await rm(dir, { recursive: true, force: true });
      } else {
        // files remain
      }
    }
    return removed;
  }
}

/** A session file's text, for finding what it names. */
export async function readSessionText(path: string | undefined): Promise<string | undefined> {
  return path !== undefined ? await readFile(path, "utf8").catch(() => undefined) : undefined;
}
