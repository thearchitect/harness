/**
 * JSON with comments and trailing commas (tsconfig.json), parsed by removing
 * both outside string literals and handing the rest to JSON.parse.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) {
        throw new SyntaxError("unterminated block comment");
      } else {
        index = end + 2;
      }
    } else if (char === ",") {
      const rest = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*([}\]])/.exec(text.slice(index + 1));
      if (rest !== null) {
        // a trailing comma before } or ]
      } else {
        out += char;
      }
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return JSON.parse(out);
}

/** Index just past the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  throw new SyntaxError("unterminated string");
}
