import assert from "node:assert/strict";
import test from "node:test";
import { writingInputs } from "../src/lib/server/writing-contract";
import { starterTemplates } from "../src/lib/starter-templates";

test("starter templates satisfy the template create contract", () => {
  assert.ok(starterTemplates.some((template) => template.kind === "note"));
  assert.ok(starterTemplates.some((template) => template.kind === "journal"));
  const names = new Set<string>();
  for (const template of starterTemplates) {
    const key = `${template.kind}:${template.name}`;
    assert.ok(!names.has(key), `${key} is duplicated`);
    names.add(key);
    const parsed = writingInputs.templateCreate.safeParse({
      name: template.name,
      description: template.description,
      kind: template.kind,
      document: template.document,
    });
    assert.ok(parsed.success, `${key}: ${parsed.error?.message}`);
  }
});
