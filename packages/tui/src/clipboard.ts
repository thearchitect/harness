// Ctrl+V as in pi (handleClipboardPaste of its interactive mode): copied files paste their paths, an
// image pastes the path of a file holding it, anything else pastes as text. pi writes the image to
// its own temp directory; here every file goes to the session's hub when the session runs on
// another machine (files_upload), so the path in the message is one its agent can read.

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type Clipboard = {
  filePaths(): Promise<string[] | null>;
  image(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  text(): Promise<string | null>;
  extensionOf(mimeType: string): string | undefined;
};

/** Where the session runs: on this machine, or on a hub that takes files through files_upload. */
export type PasteTarget = { local: true } | { local: false; upload(name: string, base64: string): Promise<string> };

/** pi's quoting of a path in a shell command (`!` messages). */
function quoteIfNeeded(value: string): string {
  return value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What Ctrl+V inserts: the paths of copied files (one per line, or quoted on one line in a shell
 * command), the path of a pasted image, or the clipboard's text; undefined when it is empty.
 */
export async function clipboardInsert(clipboard: Clipboard, target: PasteTarget, shell: boolean): Promise<{ text: string; paths: boolean } | undefined> {
  const files = await clipboard.filePaths();
  if (files !== null) {
    if (files.some((path) => /\p{Cc}/u.test(path))) {
      throw new Error("Clipboard file path contains control characters");
    } else {
      const paths = target.local ? files : await Promise.all(files.map(async (path) => target.upload(basename(path), (await readFile(path)).toString("base64"))));
      return { text: shell ? paths.map(quoteIfNeeded).join(" ") : paths.join("\n"), paths: true };
    }
  } else {
    const image = await clipboard.image();
    if (image !== null) {
      const name = `pi-clipboard-${randomUUID()}.${clipboard.extensionOf(image.mimeType) ?? "png"}`;
      if (target.local) {
        const path = join(tmpdir(), name);
        await writeFile(path, image.bytes);
        return { text: path, paths: false };
      } else {
        return { text: await target.upload(name, Buffer.from(image.bytes).toString("base64")), paths: false };
      }
    } else {
      const text = await clipboard.text();
      return text !== null && text !== "" ? { text, paths: false } : undefined;
    }
  }
}

/** pi's spacing of pasted paths: a space where the text before or after the cursor touches them. */
export function spaced(paths: string, before: string, after: string): string {
  const leading = before !== "" && !/\s/.test(before) ? " " : "";
  const trailing = after !== "" && !/\s/.test(after) ? " " : "";
  return `${leading}${paths}${trailing}`;
}
