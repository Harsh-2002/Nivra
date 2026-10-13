import assert from "node:assert/strict";
import test from "node:test";
import {
  ArticleContentBoundsError,
  assertArticleContentTreeWithinBounds,
  parseArticleContent,
} from "../src/lib/bookmark-reading";

test("article content preflight preserves canonical nested markup", () => {
  let child: unknown = { type: "text", text: "A safe saved passage." };
  for (let index = 0; index < 18; index++)
    child = { type: "strong", children: [child] };
  const content = {
    blocks: [
      { type: "heading", level: 2, children: [child] },
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            href: "https://example.test/reference",
            children: [{ type: "text", text: "Reference" }],
          },
        ],
      },
    ],
  };

  assert.deepEqual(parseArticleContent(content), content);
});

test("article content preflight rejects extreme depth without recursive parsing", () => {
  let child: unknown = { type: "text", text: "too deep" };
  for (let index = 0; index < 5000; index++)
    child = { type: "strong", children: [child] };

  assert.throws(
    () =>
      parseArticleContent({
        blocks: [{ type: "paragraph", children: [child] }],
      }),
    (error: unknown) =>
      error instanceof ArticleContentBoundsError &&
      error.message.includes("nested too deeply"),
  );
});

test("article content preflight rejects oversized trees and cycles", () => {
  assert.throws(
    () =>
      assertArticleContentTreeWithinBounds({
        blocks: new Array(300_000).fill("x"),
      }),
    ArticleContentBoundsError,
  );

  const cyclic: { blocks?: unknown } = {};
  cyclic.blocks = cyclic;
  assert.throws(
    () => assertArticleContentTreeWithinBounds(cyclic),
    ArticleContentBoundsError,
  );
});
