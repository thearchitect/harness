/**
 * send_file (server profile only): sends one file to the user in Telegram,
 * with a comment. The tool itself only checks the file; the Telegram gateway
 * (remote/) sees the call's result in pi's RPC stream and sends the document
 * where the agent is, reading the file as the user. Several files or a
 * directory: the model zips them first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Type } from "typebox";

/** Telegram's limit for files a bot sends. */
export const SEND_LIMIT = 50 * 1024 * 1024;

/** What the gateway reads from the result (remote/telegram/view.ts). */
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
    throw new Error(`${path} is ${(info.size / 1048576).toFixed(1)} MB: Telegram takes at most 50 MB from a bot`);
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
      "Send one file to the user in Telegram as a document, with a comment that says what it is.",
      "For several files or a directory, pack them first: zip -r /tmp/<name>.zip <paths>, then send the zip.",
      "At most 50 MB.",
    ].join(" "),
    promptSnippet: "Send a file to the user in Telegram with a comment",
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
        content: [{ type: "text", text: `Sent to the user in Telegram: ${file.name} (${(file.size / 1024).toFixed(0)} KB).` }],
        details: file,
      };
    },
  });
}
