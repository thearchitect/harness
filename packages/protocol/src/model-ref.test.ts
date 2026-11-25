import { test } from "node:test";
import assert from "node:assert/strict";
import { familyRefs, resolveModelRef, type CatalogModel } from "./model-ref.ts";

const catalog: CatalogModel[] = [
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-opus-5-5-fast",
  "claude-sonnet-5-5",
].map((id) => ({ provider: "anthropic", id }));
catalog.push(...["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-10-sol"].map((id) => ({ provider: "openai-codex", id })));

test("a family resolves to its newest version by numbers, not by string order", () => {
  const cases: [string, string][] = [
    ["anthropic/opus", "claude-opus-5-5"],
    ["anthropic/sonnet", "claude-sonnet-5-5"],
    ["openai-codex/sol", "gpt-10-sol"],
  ];
  for (const [ref, expected] of cases) {
    const result = resolveModelRef(ref, catalog);
    assert.ok(result.ok, ref);
    assert.equal(result.model.id, expected, ref);
    assert.equal(result.family, true, ref);
  }
});

test("variants and dated snapshots never win over the family itself", () => {
  const withFastNewest = [...catalog, { provider: "anthropic", id: "claude-opus-9-fast" }];
  const result = resolveModelRef("anthropic/opus", withFastNewest);
  assert.ok(result.ok);
  assert.equal(result.model.id, "claude-opus-5-5");
});

test("an exact id is taken as is, and the thinking suffix is kept", () => {
  const result = resolveModelRef("anthropic/claude-opus-4-8:high", catalog);
  assert.ok(result.ok);
  assert.equal(result.model.id, "claude-opus-4-8");
  assert.equal(result.thinking, "high");
  assert.equal(result.family, false);
});

test("the catalog's family references, each with the model it names now", () => {
  const refs = Object.fromEntries(familyRefs(catalog).map(({ ref, model }) => [ref, model.id]));
  assert.equal(refs["anthropic/opus"], "claude-opus-5-5");
  assert.equal(refs["anthropic/sonnet"], "claude-sonnet-5-5");
  assert.equal(refs["openai-codex/sol"], "gpt-10-sol");
  assert.equal(refs["anthropic/claude"], undefined, "claude names opus and sonnet: ambiguous");
  assert.equal(refs["anthropic/fast"], "claude-opus-5-5-fast");
});

test("a reference that cannot resolve says why", () => {
  const missing = resolveModelRef("anthropic/haiku", catalog);
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.error, "not_found");

  const invalid = resolveModelRef("opus", catalog);
  assert.equal(!invalid.ok && invalid.error, "invalid");

  const badThinking = resolveModelRef("anthropic/opus:loud", catalog);
  assert.equal(!badThinking.ok && badThinking.error, "invalid");

  const twoFamilies = resolveModelRef("x/mini", [
    { provider: "x", id: "alpha-mini-2" },
    { provider: "x", id: "beta-mini-3" },
  ]);
  assert.equal(!twoFamilies.ok && twoFamilies.error, "ambiguous");
});
