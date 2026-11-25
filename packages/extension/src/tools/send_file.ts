/**
 * send_file: offers one file to the operator, with a comment. The tool itself
 * only checks the file; every client sees the call's result and offers the
 * file for download (or "share" in the app), fetching it from the agent's node
 * with files_get. Several files or a directory: the model zips them first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Type } from "typebox";

/** Files travel to clients inside one protocol frame (files_get, base64, frames up to 64 MiB). */
export const SEND_LIMIT = 40 * 1024 * 1024;

/** What clients read from the result to offer the file. */
export type SentFileDetails = { path: string; name: string; size: number; comment: string };

/** The file to send, or why it cannot be sent. */
export async function checkFile(cwd: string, path: string, comment: string): Promise<SentFileDetails> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute).catch(() => undefined);
  if (comment.trim() === "") {
    throw new Error("comment is required: say what the file is");
  } else if (info === undefined) {
    throw new Error(`${path} does not exist`);
  } else if (info.isDirectory()) {
    throw new Error(`${path} is a directory: zip it first (zip -r /tmp/${basename(absolute) || "files"}.zip ${path}), then send the zip`);
  } else if (!info.isFile()) {
    throw new Error(`${path} is not a regular file`);
  } else if (info.size > SEND_LIMIT) {
    throw new Error(`${path} is ${(info.size / 1048576).toFixed(1)} MB: send_file takes at most ${SEND_LIMIT / 1048576} MB; split it or leave it on the machine and say where`);
  } else {
    const real = await realpath(absolute);
    return { path: real, name: basename(real), size: info.size, comment: comment.trim() };
  }
}

export function registerSendFile(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "send_file",
    label: "Send file",
    description: [
      "Send one file to the operator's devices (download or share), with a comment that says what it is.",
      "For several files or a directory, pack them first: zip -r /tmp/<name>.zip <paths>, then send the zip.",
      `At most ${SEND_LIMIT / 1048576} MB.`,
    ].join(" "),
    promptSnippet: "Send a file to the operator's devices with a comment",
    promptGuidelines: [
      "When the user asks you to produce something for them or to send them a file or folder, deliver it with send_file.",
      "Several files or a folder: zip them into /tmp first, then send_file the zip.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "The file, relative to the cwd or absolute" }),
      comment: Type.String({ description: "What the file is, shown with it" }),
    }),
    executionMode: "parallel",
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const file = await checkFile(ctx.cwd, params.path, params.comment);
      return {
        content: [{ type: "text", text: `Offered to the operator: ${file.name} (${(file.size / 1024).toFixed(0)} KB).` }],
        details: file,
      };
    },
  });
}
