/** Parses `cage dump` output: KEY=value or KEY='shell-quoted value' lines. */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match === null) {
      continue; // blank lines and comments
    } else {
      const [, key = "", raw = ""] = match;
      let value = "";
      if (raw.startsWith("'")) {
        // single-quoted segments joined by \' (POSIX shell quoting)
        for (const part of raw.matchAll(/'([^']*)'|\\(.)/g)) value += part[1] ?? part[2] ?? "";
      } else {
        value = raw;
      }
      values.set(key, value);
    }
  }
  return values;
}
