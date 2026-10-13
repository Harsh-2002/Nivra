import { createHash, randomUUID } from "node:crypto";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  articleContentSchema,
  bookmarkHighlightCreateSchema,
  type ArticleContent,
} from "../src/lib/bookmark-reading";
import { bookmarkUrl } from "../src/lib/server/link-metadata";
import { apiInputs } from "../src/lib/server/api-schemas";
import { createBookmarkHighlight } from "../src/lib/server/bookmark-reading-service";
import { bookmarks } from "../src/lib/server/schema";
import { db, sqlite } from "../src/lib/server/db";
import type { ArticleBlock } from "../src/lib/bookmark-reading";

const dataDirInput = process.env.NIVRA_DATA_DIR;
if (!dataDirInput)
  throw new Error("Set NIVRA_DATA_DIR to /tmp/nivra-foundations.*/data.");

const dataDir = path.resolve(dataDirInput);
const relative = path.relative("/tmp", dataDir).split(path.sep);
if (
  relative.length !== 2 ||
  !/^nivra-foundations\.[A-Za-z0-9_-]+$/.test(relative[0] ?? "") ||
  relative[1] !== "data" ||
  path.isAbsolute(path.relative("/tmp", dataDir))
)
  throw new Error(
    "Reader fixtures are restricted to /tmp/nivra-foundations.*/data.",
  );
if (realpathSync(dataDir) !== dataDir)
  throw new Error("NIVRA_DATA_DIR must not resolve through a symlink.");

const database = sqlite();
const owners = database
  .prepare("SELECT id,name FROM user ORDER BY created_at")
  .all() as { id: string; name: string }[];
if (owners.length !== 1 || owners[0]?.name !== "Review Owner")
  throw new Error(
    "Reader fixtures require exactly one owner named Review Owner.",
  );
const ownerId = owners[0].id;

const input = apiInputs.bookmarkCreate.parse({
  url: `https://example.test/articles/${relative[0]}`,
  collection: "Reading review",
});
const url = bookmarkUrl(input.url);
const title = "Field Notes: A saved article with annotations";
const byline = "Nivra browser fixture";
const now = Date.now();

function article(blocks: ArticleBlock[]): ArticleContent {
  return articleContentSchema.parse({ blocks });
}

function paragraph(text: string): ArticleBlock {
  return { type: "paragraph", children: [{ type: "text", text }] };
}

function heading(level: number, text: string): ArticleBlock {
  return { type: "heading", level, children: [{ type: "text", text }] };
}

function articleText(content: ArticleContent) {
  return content.blocks
    .map((block) => {
      if ("children" in block)
        return block.children
          .map((inline) => (inline.type === "text" ? inline.text : ""))
          .join("");
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

const versions = [
  {
    version: 1,
    capturedAt: now - 86_400_000,
    title: "Field notes on a sticky valve",
    content: article([
      heading(1, "Field notes on a sticky valve"),
      paragraph(
        "The north workshop valve began sticking after the first cold week. I recorded the checks here so the repair can be repeated without guessing.",
      ),
      paragraph(
        "Before removing the handle, check the brass washer and clean away grit with a dry cloth. The old blue valve should turn gently.",
      ),
      paragraph(
        "The old blue valve should turn gently. If it catches, stop and inspect the stem instead of applying more force.",
      ),
      heading(2, "After the first test"),
      paragraph(
        "Measure twice before closing the valve. Leave the panel open until the pressure reading stays steady for a full minute.",
      ),
    ]),
  },
  {
    version: 2,
    capturedAt: now,
    title: "Field notes on a sticky valve — updated",
    content: article([
      heading(1, "Field notes on a sticky valve"),
      paragraph(
        "A newer inspection found the cause: moisture had collected below the north workshop handle. This version adds the replacement-seal check.",
      ),
      paragraph(
        "Before removing the handle, check the brass washer and clean away grit with a dry cloth. The old blue valve should turn gently.",
      ),
      paragraph(
        "The old blue valve should turn gently. If it catches, stop and inspect the stem instead of applying more force.",
      ),
      heading(2, "After the cold test"),
      paragraph(
        "Check the gasket again after the cold test. Leave the panel open until the pressure reading stays steady for a full minute.",
      ),
      paragraph(
        "The brass latch settled after the second adjustment. A photo of the finished handle belongs with the maintenance log.",
      ),
    ]),
  },
];

const existing = database
  .prepare("SELECT id FROM bookmarks WHERE owner_id=? AND url=?")
  .get(ownerId, url) as { id: string } | undefined;
const bookmarkId = existing?.id ?? randomUUID();
const articleUrl = url;

database
  .transaction(() => {
    if (existing)
      database
        .prepare("DELETE FROM bookmarks WHERE id=? AND owner_id=?")
        .run(existing.id, ownerId);
    db()
      .insert(bookmarks)
      .values({
        id: bookmarkId,
        ownerId,
        url,
        title,
        description: "A synthetic article for saved-reader browser checks.",
        siteName: "example.test",
        collection: input.collection,
        metadataStatus: "unavailable",
        articleStatus: "ready",
        articleGeneration: versions.length,
        articleVersion: versions.length,
        titleEdited: 1,
        descriptionEdited: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertArticle = database.prepare(
      "INSERT INTO bookmark_articles(bookmark_id,owner_id,version,source_url,captured_at,title,byline,content_json,plain_text,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    for (const version of versions) {
      const content = articleContentSchema.parse(version.content);
      const text = articleText(content);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ title: version.title, byline, content }))
        .digest("hex");
      insertArticle.run(
        bookmarkId,
        ownerId,
        version.version,
        articleUrl,
        version.capturedAt,
        version.title,
        byline,
        JSON.stringify(content),
        text,
        fingerprint,
      );
    }
  })
  .immediate();

function anchor(version: number, quote: string, occurrence = 0) {
  const content = versions[version - 1]?.content;
  if (!content)
    throw new Error(`Fixture article version ${version} is missing.`);
  const text = articleText(content);
  let startOffset = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    startOffset = text.indexOf(quote, from);
    if (startOffset < 0) throw new Error(`Fixture quote not found: ${quote}`);
    from = startOffset + quote.length;
  }
  const endOffset = startOffset + quote.length;
  return bookmarkHighlightCreateSchema.parse({
    articleVersion: version,
    quote,
    prefix: text.slice(Math.max(0, startOffset - 32), startOffset),
    suffix: text.slice(endOffset, endOffset + 32),
    startOffset,
    endOffset,
    annotation:
      version === 1
        ? "Original observation: inspect the stem before forcing it."
        : "Recheck this seal after the cold test.",
  });
}

const highlights = [
  createBookmarkHighlight(
    ownerId,
    bookmarkId,
    anchor(1, "The old blue valve should turn gently.", 1),
  ),
  createBookmarkHighlight(
    ownerId,
    bookmarkId,
    anchor(2, "Check the gasket again after the cold test."),
  ),
];

const manifest = {
  schemaVersion: 1,
  bookmarkId,
  title,
  url,
  bookmark: { id: bookmarkId, title, url },
  currentVersion: versions.length,
  articleText: articleText(versions.at(-1)!.content),
  olderVersionText: articleText(versions[0]!.content),
  highlightQuote: highlights.at(-1)!.quote,
  selectionQuote:
    "A photo of the finished handle belongs with the maintenance log.",
  annotation: highlights.at(-1)!.annotation,
  versions: versions.map(({ version, capturedAt, title }) => ({
    version,
    capturedAt,
    title,
  })),
  highlights: highlights.map((highlight) => ({
    id: highlight.id,
    articleVersion: highlight.articleVersion,
    quote: highlight.quote,
    annotation: highlight.annotation,
    startOffset: highlight.startOffset,
    endOffset: highlight.endOffset,
  })),
};
const manifestPath = path.join(dataDir, "browser-reader-fixture.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
chmodSync(manifestPath, 0o600);
console.log(JSON.stringify({ manifestPath, ...manifest }));
