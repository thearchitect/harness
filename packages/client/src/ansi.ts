// ANSI lines as a terminal draws them, for UIs that are no terminal (the app showing an extension's
// component drawn in the agent): each line becomes spans of text with their style — SGR colors (16,
// 256, truecolor), bold, dim, italic, underline, inverse — and OSC 8 links. pi-tui's own markers
// (APC `\x1b_pi:…\x07`) are dropped; its cursor marker becomes the cursor's cell.

export type AnsiStyle = {
  /** "#rrggbb", or undefined for the terminal's own color. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  link?: string;
};

export type AnsiSpan = { text: string; style: AnsiStyle };

export type AnsiLine = { spans: AnsiSpan[]; /** The column of pi-tui's cursor marker on this line. */ cursor?: number };

/** xterm's 16 colors. */
const BASIC = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5", "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"];

const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** A color of xterm's 256. */
export function color256(index: number): string {
  if (index < 16) {
    return BASIC[index] ?? "#ffffff";
  } else if (index < 232) {
    const cube = index - 16;
    const level = (component: number): number => (component === 0 ? 0 : 55 + component * 40);
    return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`;
  } else {
    const gray = 8 + (index - 232) * 10;
    return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
  }
}

/** The style after an SGR sequence's parameters. */
function applySgr(style: AnsiStyle, parameters: number[]): AnsiStyle {
  const next: AnsiStyle = { ...style };
  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index] ?? 0;
    if (code === 0) {
      for (const key of ["fg", "bg", "bold", "dim", "italic", "underline", "inverse"] as const) {
        delete next[key];
      }
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 24) {
      delete next.underline;
    } else if (code === 27) {
      delete next.inverse;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      next.fg = BASIC[code >= 90 ? code - 90 + 8 : code - 30];
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      next.bg = BASIC[code >= 100 ? code - 100 + 8 : code - 40];
    } else if (code === 39) {
      delete next.fg;
    } else if (code === 49) {
      delete next.bg;
    } else if (code === 38 || code === 48) {
      // 38;5;n or 38;2;r;g;b (and 48 for the background)
      const mode = parameters[index + 1];
      const value =
        mode === 5
          ? color256(parameters[index + 2] ?? 0)
          : mode === 2
            ? `#${hex(parameters[index + 2] ?? 0)}${hex(parameters[index + 3] ?? 0)}${hex(parameters[index + 4] ?? 0)}`
            : undefined;
      index += mode === 5 ? 2 : mode === 2 ? 4 : 0;
      if (value !== undefined) {
        next[code === 38 ? "fg" : "bg"] = value;
      } else {
        // an unknown color form: ignored as a terminal would
      }
    } else {
      // blinking, fonts and the like: no look here
    }
  }
  return next;
}

/** One ANSI line as styled spans. */
export function parseAnsiLine(line: string): AnsiLine {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let text = "";
  let column = 0;
  let cursor: number | undefined;
  const flush = (): void => {
    if (text !== "") {
      spans.push({ text, style });
      text = "";
    } else {
      // nothing in this style
    }
  };
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? "";
    if (char !== "\x1b") {
      text += char;
      column += 1;
      index += 1;
    } else if (line[index + 1] === "[") {
      // CSI: SGR is the one with a look; others are dropped
      const end = line.slice(index + 2).search(/[@-~]/);
      const final = end >= 0 ? line[index + 2 + end] : undefined;
      if (end >= 0 && final === "m") {
        flush();
        const body = line.slice(index + 2, index + 2 + end);
        style = applySgr(style, body === "" ? [0] : body.split(";").map((part) => Number.parseInt(part, 10) || 0));
      } else {
        // a cursor move or the like
      }
      index = end >= 0 ? index + 3 + end : line.length;
    } else if (line[index + 1] === "]") {
      // OSC: 8;;url is a link (ended by BEL or ST)
      const rest = line.slice(index + 2);
      const bel = rest.indexOf("\x07");
      const st = rest.indexOf("\x1b\\");
      const end = bel >= 0 && (st < 0 || bel < st) ? { at: bel, length: 1 } : st >= 0 ? { at: st, length: 2 } : { at: rest.length, length: 0 };
      const body = rest.slice(0, end.at);
      if (body.startsWith("8;")) {
        flush();
        const url = body.slice(body.indexOf(";", 2) + 1);
        style = url !== "" ? { ...style, link: url } : (({ link: _link, ...without }) => without)(style);
      } else {
        // a title or the like
      }
      index += 2 + end.at + end.length;
    } else if (line[index + 1] === "_") {
      // APC: pi-tui's markers; its cursor marker is the cursor's cell
      const end = line.indexOf("\x07", index + 2);
      const body = line.slice(index + 2, end >= 0 ? end : line.length);
      if (body === "pi:c") {
        cursor = column;
      } else {
        // another marker of pi-tui's
      }
      index = end >= 0 ? end + 1 : line.length;
    } else {
      // a lone escape: dropped
      index += 2;
    }
  }
  flush();
  return cursor !== undefined ? { spans, cursor } : { spans };
}
