import test from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixtures/local-ai-frozen.json";
import { tagCandidates, policy } from "../src/lib/server/ai/policy";
import { modelVersion } from "../src/lib/server/ai/model";
test("frozen Arctic examples preserve conservative filtering and abstention", () => {
  assert.ok(modelVersion.includes(fixture.revision));
  for (const item of fixture.cases) {
    const scores = new Map(item.scores.map((row) => [row.name, row.score]));
    const shown = tagCandidates(item.text, fixture.vocabulary)
      .map((row) => ({ ...row, score: scores.get(row.tag.name) ?? 0 }))
      .filter((row) => row.score >= policy.semanticThreshold)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.support - a.support ||
          a.tag.name.localeCompare(b.tag.name),
      )
      .slice(0, policy.maxTags)
      .map((row) => row.tag.name);
    assert.deepEqual(shown, item.expected, item.id);
  }
});
test("source cue scanning preserves distinct-token support for large text", () => {
  const vocabulary = [
    {
      id: "database",
      name: "database",
      aliases: ["database databases sqlite sql"],
    },
    {
      id: "routing",
      name: "routing",
      aliases: ["sqlite router routers"],
    },
  ];
  const text = [
    "Databases DATABASE sqlite sql sql router routers routing",
    ...Array.from({ length: 20_000 }, (_, index) => `irrelevant-${index}`),
  ].join(" ");
  assert.deepEqual(
    tagCandidates(text, vocabulary).map(({ tag, support }) => ({
      id: tag.id,
      support,
    })),
    [
      { id: "database", support: 2.5 },
      { id: "routing", support: 2.5 },
    ],
  );
  assert.deepEqual(tagCandidates("database sqlite", vocabulary), []);
});
