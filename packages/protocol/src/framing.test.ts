import { test } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder, decodeRecord, encodeRecord } from "./framing.ts";

test("records split only at LF, across chunk boundaries, with CR dropped", () => {
  const decoder = new LineDecoder();
  const text = encodeRecord({ a: "x\u2028y" }) + '{"b":1}\r\n{"c":';
  const bytes = new TextEncoder().encode(text);
  const lines = [...decoder.push(bytes.slice(0, 5)), ...decoder.push(bytes.slice(5))];
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ a: "x\u2028y" }, { b: 1 }]);
  assert.deepEqual(decoder.push('2}\n').map((line) => JSON.parse(line)), [{ c: 2 }]);
  assert.deepEqual(decoder.end(), []);
});

test("a final record without LF is delivered at the end of the stream", () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"a":1}'), []);
  assert.deepEqual(decoder.end(), ['{"a":1}']);
});

test("only JSON objects are records", () => {
  assert.equal(decodeRecord("[1]").ok, false);
  assert.equal(decodeRecord("nope").ok, false);
  assert.deepEqual(decodeRecord('{"type":"x"}'), { ok: true, record: { type: "x" } });
});
