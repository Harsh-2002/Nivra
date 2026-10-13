import { z } from "./zod";

const articleInlineSchema: z.ZodType<ArticleInline> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().max(200_000) }),
    z.object({
      type: z.literal("link"),
      href: z
        .string()
        .url()
        .max(4096)
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password
            );
          } catch {
            return false;
          }
        }),
      children: z.array(articleInlineSchema).max(256),
    }),
    z.object({
      type: z.literal("strong"),
      children: z.array(articleInlineSchema).max(256),
    }),
    z.object({
      type: z.literal("emphasis"),
      children: z.array(articleInlineSchema).max(256),
    }),
    z.object({
      type: z.literal("code"),
      children: z.array(articleInlineSchema).max(256),
    }),
  ]),
);

const articleBlockSchema: z.ZodType<ArticleBlock> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("heading"),
      level: z.number().int().min(1).max(6),
      children: z.array(articleInlineSchema).max(256),
    }),
    z.object({
      type: z.literal("paragraph"),
      children: z.array(articleInlineSchema).max(512),
    }),
    z.object({
      type: z.literal("quote"),
      children: z.array(articleInlineSchema).max(512),
    }),
    z.object({
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z.array(z.array(articleInlineSchema).max(256)).max(500),
    }),
    z.object({ type: z.literal("code-block"), text: z.string().max(200_000) }),
    z.object({
      type: z.literal("table"),
      header: z.array(z.string().max(2000)).max(32),
      rows: z.array(z.array(z.string().max(2000)).max(32)).max(500),
    }),
    z.object({ type: z.literal("rule") }),
  ],
);

export type ArticleInline =
  | { type: "text"; text: string }
  | { type: "link"; href: string; children: ArticleInline[] }
  | { type: "strong" | "emphasis" | "code"; children: ArticleInline[] };

export type ArticleBlock =
  | { type: "heading"; level: number; children: ArticleInline[] }
  | { type: "paragraph" | "quote"; children: ArticleInline[] }
  | { type: "list"; ordered: boolean; items: ArticleInline[][] }
  | { type: "code-block"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "rule" };

export type ArticleContent = { blocks: ArticleBlock[] };
export const articleContentSchema = z.object({
  blocks: z.array(articleBlockSchema).max(5000),
});

const maxArticleTreeDepth = 64;
const maxArticleTreeValues = 300_000;

export class ArticleContentBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleContentBoundsError";
  }
}

type ArticleTreeFrame = {
  value: Record<string, unknown> | unknown[];
  depth: number;
  keys?: string[];
  index: number;
};

export function assertArticleContentTreeWithinBounds(input: unknown): void {
  if (!input || typeof input !== "object") return;

  const seen = new WeakSet<object>();
  const root = input as Record<string, unknown> | unknown[];
  seen.add(root);
  const stack: ArticleTreeFrame[] = [{ value: root, depth: 0, index: 0 }];
  let values = 1;

  while (stack.length) {
    const frame = stack[stack.length - 1];
    let childCount: number;
    if (Array.isArray(frame.value)) childCount = frame.value.length;
    else childCount = (frame.keys ??= Object.keys(frame.value)).length;
    if (frame.index >= childCount) {
      stack.pop();
      continue;
    }
    if (childCount - frame.index > maxArticleTreeValues - values)
      throw new ArticleContentBoundsError(
        "Article content contains too many nodes.",
      );

    let child: unknown;
    if (Array.isArray(frame.value)) child = frame.value[frame.index++];
    else {
      const keys = (frame.keys ??= Object.keys(frame.value));
      child = (frame.value as Record<string, unknown>)[keys[frame.index++]];
    }
    values++;
    if (!child || typeof child !== "object") continue;
    if (frame.depth >= maxArticleTreeDepth)
      throw new ArticleContentBoundsError(
        "Article content is nested too deeply.",
      );
    if (seen.has(child))
      throw new ArticleContentBoundsError(
        "Article content must be a finite tree.",
      );
    seen.add(child);
    stack.push({
      value: child as Record<string, unknown> | unknown[],
      depth: frame.depth + 1,
      index: 0,
    });
  }
}

export function parseArticleContent(input: unknown): ArticleContent {
  assertArticleContentTreeWithinBounds(input);
  return articleContentSchema.parse(input);
}

export type ArticleStatus = "pending" | "ready" | "unavailable";

export type BookmarkArticle = {
  bookmarkId: string;
  version: number;
  url: string;
  capturedAt: number;
  title: string;
  byline: string | null;
  fingerprint: string;
  content: ArticleContent;
  text: string;
};

export type BookmarkArticleResult = {
  status: ArticleStatus;
  currentVersion: number;
  article: BookmarkArticle | null;
  jobId: string | null;
};

export type BookmarkHighlight = {
  id: string;
  bookmarkId: string;
  articleVersion: number;
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
  endOffset: number;
  annotation: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export const articleActionSchema = z
  .object({ action: z.enum(["save", "retry", "refresh"]) })
  .strict();

export const bookmarkReadStateBatchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            revision: z.number().int().positive(),
            read: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const bookmarkHighlightCreateSchema = z
  .object({
    articleVersion: z.number().int().positive(),
    quote: z.string().min(1).max(10_000),
    prefix: z.string().max(256).default(""),
    suffix: z.string().max(256).default(""),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    annotation: z.string().max(3000).default(""),
  })
  .strict()
  .refine((input) => input.endOffset > input.startOffset);

export const bookmarkHighlightReanchorSchema = z
  .object({
    articleVersion: z.number().int().positive(),
    quote: z.string().min(1).max(10_000),
    prefix: z.string().max(256).default(""),
    suffix: z.string().max(256).default(""),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
  })
  .strict()
  .refine((input) => input.endOffset > input.startOffset);

export const bookmarkHighlightUpdateSchema = z
  .object({
    revision: z.number().int().positive(),
    annotation: z.string().max(3000).optional(),
    reanchor: bookmarkHighlightReanchorSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.annotation !== undefined || input.reanchor !== undefined,
  );

export const bookmarkHighlightDeleteSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();
