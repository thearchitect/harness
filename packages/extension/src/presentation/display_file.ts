// display_file's rows: pure functions of the call's arguments and the result's details.

import { getMarkdownTheme, highlightCode, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Image, Markdown, Text, type Component } from "@earendil-works/pi-tui";

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

type DisplayArgs = { path?: string; offset?: number; limit?: number };

type ResultLike = { content: { type: string; text?: string }[]; details?: unknown };

/** Image width in cells, as the operator's client settings say. */
const IMAGE_WIDTH_CELLS = 60;

export const displayFileRenderers = {
  renderCall(args: DisplayArgs, theme: Theme): Component {
    const range =
      args.offset !== undefined || args.limit !== undefined ? `:${args.offset ?? 1}${args.limit !== undefined ? `+${args.limit}` : ""}` : "";
    return new Text(`${theme.fg("toolTitle", theme.bold("display_file "))}${theme.fg("accent", `${args.path ?? ""}${range}`)}`, 0, 0);
  },

  // Always shown whole: showing the file is the point of the call.
  renderResult(result: ResultLike, _options: ToolRenderResultOptions, theme: Theme, context: { isError: boolean; showImages: boolean }): Component {
    const details = result.details as DisplayDetails | undefined;
    if (details === undefined) {
      const text = result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
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
            return new Image(details.data, details.mimeType, { fallbackColor: (text) => theme.fg("toolOutput", text) }, { maxWidthCells: IMAGE_WIDTH_CELLS });
          } else {
            return new Text(theme.fg("dim", `[image ${details.originalWidth}×${details.originalHeight} ${details.path}: this client does not show images]`), 0, 0);
          }
        default:
          throw new Error(`unknown display kind: ${String(kind satisfies never)}`);
      }
    }
  },
};
