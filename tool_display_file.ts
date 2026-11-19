/**
 * display_file (desktop profile only): shows a text file or an image to the
 * operator in the transcript. The model gets one line saying what was shown,
 * never the content; the shown snapshot lives in the result's details, so a
 * resumed session and an HTML export show what the operator saw.
 */

import {
  convertToPng,
  detectSupportedImageMimeTypeFromFile,
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
  resizeImage,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Image, Markdown, Text } from "@earendil-works/pi-tui";
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

/** What the renderer shows; stored with the result, never sent to the model. */
export type DisplayDetails =
  | {
      kind: "text";
      path: string;
      text: string;
      language: string | undefined;
      markdown: boolean;
      firstLine: number;
      lastLine: number;
      totalLines: number;
    }
  | {
      kind: "image";
      path: string;
      data: string;
      mimeType: string;
      width: number;
      height: number;
      originalWidth: number;
      originalHeight: number;
    };

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
  const imageWidthCells = (): number => pi.getSettings().terminal?.imageWidthCells ?? 60;

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
      if (ctx.mode !== "tui") {
        throw new Error(`display_file shows files in pi's TUI; this session runs in ${ctx.mode} mode`);
      } else {
        const display = await prepareDisplay(ctx.cwd, params.path, params.offset, params.limit);
        const kind = display.details.kind;
        switch (kind) {
          case "text":
            break; // every terminal shows text
          case "image":
            if (getCapabilities().images === null) {
              throw new Error("this terminal cannot show images (no Kitty or iTerm2 graphics)");
            } else if (pi.getSettings().terminal?.showImages === false) {
              throw new Error("the operator turned images off (terminal.showImages)");
            } else {
              break; // the terminal shows it
            }
          default:
            throw new Error(`unknown display kind: ${String(kind satisfies never)}`);
        }
        return { content: [{ type: "text", text: display.summary }], details: display.details };
      }
    },

    renderCall(args, theme) {
      const range =
        args.offset !== undefined || args.limit !== undefined
          ? `:${args.offset ?? 1}${args.limit !== undefined ? `+${args.limit}` : ""}`
          : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("display_file "))}${theme.fg("accent", `${args.path ?? ""}${range}`)}`, 0, 0);
    },

    // Always shown whole: showing the file is the point of the call.
    renderResult(result, _options, theme, context) {
      const details = result.details as DisplayDetails | undefined;
      if (details === undefined) {
        const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        return new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0);
      } else {
        const kind = details.kind;
        switch (kind) {
          case "text": {
            const container = new Container();
            if (details.markdown) {
              container.addChild(new Markdown(details.text, 0, 0, getMarkdownTheme()));
            } else if (details.language !== undefined) {
              container.addChild(new Text(highlightCode(details.text, details.language).join("\n"), 0, 0));
            } else {
              container.addChild(new Text(theme.fg("toolOutput", details.text), 0, 0));
            }
            if (details.totalLines === 0) {
              container.addChild(new Text(theme.fg("dim", "(empty file)"), 0, 0));
            } else if (details.firstLine > 1 || details.lastLine < details.totalLines) {
              container.addChild(new Text(theme.fg("dim", `lines ${details.firstLine}-${details.lastLine} of ${details.totalLines}`), 0, 0));
            } else {
              // the whole file is shown
            }
            return container;
          }
          case "image":
            if (context.showImages) {
              return new Image(details.data, details.mimeType, { fallbackColor: (text) => theme.fg("toolOutput", text) }, { maxWidthCells: imageWidthCells() });
            } else {
              return new Text(theme.fg("dim", `[image ${details.originalWidth}×${details.originalHeight} hidden: terminal.showImages is off]`), 0, 0);
            }
          default:
            throw new Error(`unknown display kind: ${String(kind satisfies never)}`);
        }
      }
    },
  });
}
