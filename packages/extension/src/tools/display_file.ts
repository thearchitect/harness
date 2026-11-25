/**
 * display_file: shows a text file or an image to the operator in the
 * transcript. The model gets one line saying what was shown, never the
 * content; the shown snapshot lives in the result's details, so every client,
 * a resumed session and an HTML export show what the operator saw
 * (presentation/display_file.ts draws it).
 */

import {
  convertToPng,
  detectSupportedImageMimeTypeFromFile,
  getLanguageFromPath,
  resizeImage,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Type } from "typebox";

/** The largest file display_file reads. */
export const DISPLAY_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** One display of a text file: at most this many lines and bytes. */
export const DISPLAY_MAX_LINES = 2000;
export const DISPLAY_MAX_BYTES = 256 * 1024;
/** Images are scaled down to fit these before they are stored with the result. */
export const DISPLAY_IMAGE_MAX_PX = 1600;
export const DISPLAY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

import { displayFileRenderers, type DisplayDetails } from "../presentation/display_file.ts";

export type { DisplayDetails };

/** A prepared display: the snapshot and the one line the model gets. */
export type Display = { details: DisplayDetails; summary: string };

function lineNumber(name: string, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  } else if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number from 1`);
  } else {
    return value;
  }
}

/** Reads the file and prepares what the operator sees, or says why it cannot be shown. */
export async function prepareDisplay(cwd: string, path: string, offset?: number, limit?: number): Promise<Display> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`${path} does not exist`);
  } else if (info.isDirectory()) {
    throw new Error(`${path} is a directory`);
  } else if (!info.isFile()) {
    throw new Error(`${path} is not a regular file`);
  } else if (info.size > DISPLAY_FILE_MAX_BYTES) {
    throw new Error(`${path} is ${(info.size / 1048576).toFixed(1)} MB: display_file reads at most ${DISPLAY_FILE_MAX_BYTES / 1048576} MB`);
  } else {
    const mimeType = await detectSupportedImageMimeTypeFromFile(absolute);
    if (mimeType === null) {
      return prepareText(absolute, path, lineNumber("offset", offset), lineNumber("limit", limit));
    } else if (offset !== undefined || limit !== undefined) {
      throw new Error("offset and limit apply to text files, not to images");
    } else {
      return prepareImage(absolute, path, mimeType);
    }
  }
}

async function prepareImage(absolute: string, path: string, mimeType: string): Promise<Display> {
  const resized = await resizeImage(await readFile(absolute), mimeType, {
    maxWidth: DISPLAY_IMAGE_MAX_PX,
    maxHeight: DISPLAY_IMAGE_MAX_PX,
    maxBytes: DISPLAY_IMAGE_MAX_BYTES,
  });
  if (resized === null) {
    throw new Error(`${path} could not be decoded as ${mimeType}`);
  } else {
    // Kitty terminals take PNG only.
    const png = resized.mimeType === "image/png" ? resized : await convertToPng(resized.data, resized.mimeType);
    if (png === null) {
      throw new Error(`${path} could not be converted to PNG for the terminal`);
    } else {
      return {
        details: {
          kind: "image",
          path,
          data: png.data,
          mimeType: png.mimeType,
          width: resized.width,
          height: resized.height,
          originalWidth: resized.originalWidth,
          originalHeight: resized.originalHeight,
        },
        summary: `Displayed to the operator: ${path} (image ${resized.originalWidth}×${resized.originalHeight}).`,
      };
    }
  }
}

/** The file as UTF-8 text, or undefined when it is binary. */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  } else {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined; // not UTF-8
    }
  }
}

async function prepareText(absolute: string, path: string, offset: number | undefined, limit: number | undefined): Promise<Display> {
  const text = decodeText(await readFile(absolute));
  if (text === undefined) {
    throw new Error(`${path} is neither text (UTF-8) nor an image display_file can show (PNG, JPEG, GIF, WebP)`);
  } else {
    return sliceText(text, path, getLanguageFromPath(absolute), MARKDOWN_EXTENSIONS.includes(extname(absolute).toLowerCase()), offset ?? 1, limit);
  }
}

function sliceText(text: string, path: string, language: string | undefined, markdown: boolean, first: number, limit: number | undefined): Display {
  const lines = text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (lines.length === 0) {
    return {
      details: { kind: "text", path, text: "", language, markdown, firstLine: 0, lastLine: 0, totalLines: 0 },
      summary: `Displayed to the operator: ${path} (empty file).`,
    };
  } else if (first > lines.length) {
    throw new Error(`offset ${first} is beyond the end of ${path} (${lines.length} lines)`);
  } else {
    const slice = lines.slice(first - 1, limit === undefined ? undefined : first - 1 + limit);
    const shown = truncateHead(slice.join("\n"), { maxLines: DISPLAY_MAX_LINES, maxBytes: DISPLAY_MAX_BYTES });
    if (shown.firstLineExceedsLimit) {
      throw new Error(`line ${first} of ${path} is longer than ${DISPLAY_MAX_BYTES / 1024} KB`);
    } else {
      const last = first + shown.outputLines - 1;
      const more = shown.truncated ? ` That is the display limit: call display_file with offset ${last + 1} to show more.` : "";
      return {
        details: { kind: "text", path, text: shown.content, language, markdown, firstLine: first, lastLine: last, totalLines: lines.length },
        summary: `Displayed to the operator: ${path}, lines ${first}-${last} of ${lines.length}.${more}`,
      };
    }
  }
}

export function registerDisplayFile(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "display_file",
    label: "Display file",
    description: [
      "Show a text file or an image (PNG, JPEG, GIF, WebP) to the operator in the chat.",
      "You get only a one-line confirmation, never the content.",
      `Text: lines offset..offset+limit-1 (1-based; default the whole file), at most ${DISPLAY_MAX_LINES} lines or ${DISPLAY_MAX_BYTES / 1024} KB per call; Markdown is rendered, code highlighted.`,
    ].join(" "),
    promptSnippet: "Show a text file or an image to the operator without reading it into context",
    promptGuidelines: [
      "When the operator asks to see a file or an image, or a file you produced is itself the answer, show it with display_file instead of reading it and retyping it.",
      "display_file shows the content to the operator only: you have not seen it, so do not describe it as if you had read it.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "The file, relative to the cwd or absolute" }),
      offset: Type.Optional(Type.Number({ description: "Text files: the first line to show, 1-based" })),
      limit: Type.Optional(Type.Number({ description: "Text files: how many lines to show" })),
    }),
    executionMode: "parallel",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const display = await prepareDisplay(ctx.cwd, params.path, params.offset, params.limit);
      return { content: [{ type: "text", text: display.summary }], details: display.details };
    },
    renderCall: displayFileRenderers.renderCall,
    renderResult: displayFileRenderers.renderResult,
  });
}
