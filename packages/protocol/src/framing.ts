// JSONL framing shared by every harness stream (HAP on stdio, the node protocol on sockets).
// One JSON value per line; only LF separates records, a CR before it is dropped; U+2028 and
// U+2029 are ordinary characters inside JSON strings, never separators (as pi's jsonl.ts).

export function encodeRecord(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

/** Splits a byte or text stream into complete lines; keeps an unfinished tail between chunks. */
export class LineDecoder {
  private tail = "";
  private readonly decoder = new TextDecoder();

  /** Feeds a chunk and returns the complete lines it finished (without their terminators). */
  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const parts = (this.tail + text).split("\n");
    this.tail = parts.pop() ?? "";
    return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line !== "");
  }

  /** The unfinished tail when the stream ends: a final record without a trailing LF. */
  end(): string[] {
    const rest = this.tail + this.decoder.decode();
    this.tail = "";
    if (rest.trim() === "") {
      return [];
    } else {
      return [rest.endsWith("\r") ? rest.slice(0, -1) : rest];
    }
  }
}

/** Parses one line into a record; malformed JSON or a non-object is a protocol error. */
export function decodeRecord(line: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { ok: false, error: `malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ok: true, record: value as Record<string, unknown> };
  } else {
    return { ok: false, error: "a record must be a JSON object" };
  }
}
