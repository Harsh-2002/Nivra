"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  ExternalLink,
  FileText,
  Highlighter,
  LoaderCircle,
  RotateCw,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import type {
  ArticleBlock,
  ArticleContent,
  ArticleInline,
  BookmarkArticle,
  BookmarkArticleResult,
  BookmarkHighlight,
} from "@/lib/bookmark-reading";
import type { Bookmark, Note } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/confirm-provider";

type VersionPage = {
  items: { version: number; capturedAt: number; title: string }[];
  next: string | null;
};
type HighlightPage = { items: BookmarkHighlight[]; next: string | null };
type ReadStateResult = {
  items: {
    id: string;
    status: "updated" | "unchanged" | "conflict" | "not_found";
    bookmark?: Bookmark;
  }[];
};
type Anchor = {
  articleVersion: number;
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
  endOffset: number;
};

function inlineText(items: ArticleInline[]): string {
  return items
    .map((item) =>
      item.type === "text" ? item.text : inlineText(item.children),
    )
    .join("");
}

function blockText(block: ArticleBlock): string {
  if (block.type === "rule") return "";
  if (block.type === "code-block") return block.text;
  if (block.type === "table")
    return [...block.header, ...block.rows.flat()].join(" ");
  if (block.type === "list") return block.items.map(inlineText).join("\n");
  return inlineText(block.children);
}

function articleText(content: ArticleContent) {
  return content.blocks.map(blockText).filter(Boolean).join("\n\n");
}

function safeArticleLink(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function bookmarkHostname(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function displayDate(value: number) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function normalizeSelection(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectedPointOffset(root: HTMLElement, node: Node, offset: number) {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  const span = element?.closest<HTMLElement>("[data-reader-start]");
  if (!span || !root.contains(span)) return null;
  const base = Number(span.dataset.readerStart);
  if (!Number.isSafeInteger(base)) return null;
  const range = document.createRange();
  range.selectNodeContents(span);
  try {
    const safeOffset =
      node.nodeType === Node.TEXT_NODE
        ? Math.min(offset, node.textContent?.length ?? 0)
        : Math.min(offset, node.childNodes.length);
    range.setEnd(node, safeOffset);
    return base + range.toString().length;
  } catch {
    return null;
  }
}

function renderInlineText(
  text: string,
  offset: number,
  highlights: BookmarkHighlight[],
  key: string,
) {
  const overlapping = highlights.filter(
    (highlight) =>
      highlight.startOffset < offset + text.length &&
      highlight.endOffset > offset,
  );
  const boundaries = new Set<number>([0, text.length]);
  for (const highlight of overlapping) {
    boundaries.add(Math.max(0, highlight.startOffset - offset));
    boundaries.add(Math.min(text.length, highlight.endOffset - offset));
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const parts = points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    if (end <= start) return null;
    const absoluteStart = offset + start;
    const absoluteEnd = offset + end;
    const active = overlapping.filter(
      (highlight) =>
        highlight.startOffset < absoluteEnd &&
        highlight.endOffset > absoluteStart,
    );
    const chunk = text.slice(start, end);
    return active.length ? (
      <mark
        key={`${key}-${start}`}
        data-highlight-ids={active.map((highlight) => highlight.id).join(" ")}
        className="rounded-sm bg-foreground/10 px-px text-inherit dark:bg-foreground/20"
      >
        {chunk}
      </mark>
    ) : (
      <span key={`${key}-${start}`}>{chunk}</span>
    );
  });
  return (
    <span data-reader-start={offset} className="whitespace-pre-wrap">
      {parts}
    </span>
  );
}

function renderInline(
  items: ArticleInline[],
  start: number,
  highlights: BookmarkHighlight[],
  key: string,
): { nodes: React.ReactNode[]; end: number } {
  let offset = start;
  const nodes = items.map((item, index) => {
    const keyPart = `${key}-${index}`;
    if (item.type === "text") {
      const node = renderInlineText(item.text, offset, highlights, keyPart);
      offset += item.text.length;
      return node;
    }
    const children = renderInline(item.children, offset, highlights, keyPart);
    offset = children.end;
    if (item.type === "link") {
      const href = safeArticleLink(item.href);
      return href ? (
        <a key={keyPart} href={href} target="_blank" rel="noreferrer noopener">
          {children.nodes}
        </a>
      ) : (
        <span key={keyPart}>{children.nodes}</span>
      );
    }
    if (item.type === "strong")
      return <strong key={keyPart}>{children.nodes}</strong>;
    if (item.type === "emphasis")
      return <em key={keyPart}>{children.nodes}</em>;
    return <code key={keyPart}>{children.nodes}</code>;
  });
  return { nodes, end: offset };
}

function renderArticleBlock(
  block: ArticleBlock,
  start: number,
  highlights: BookmarkHighlight[],
  index: number,
) {
  const key = `block-${index}`;
  if (block.type === "rule") return <hr key={key} />;
  if (block.type === "code-block")
    return (
      <pre key={key}>
        <code>{renderInlineText(block.text, start, highlights, key)}</code>
      </pre>
    );
  if (block.type === "table") {
    let offset = start;
    let hasCell = false;
    const renderCells = (cells: string[], prefix: string) =>
      cells.map((value, cellIndex) => {
        if (hasCell) offset += 1;
        hasCell = true;
        const text = renderInlineText(
          value,
          offset,
          highlights,
          `${key}-${prefix}-${cellIndex}`,
        );
        offset += value.length;
        return <th key={`${prefix}-${cellIndex}`}>{text}</th>;
      });
    const header = renderCells(block.header, "head");
    const rows = block.rows.map((row, rowIndex) => (
      <tr key={`${key}-row-${rowIndex}`}>
        {row.map((value, cellIndex) => {
          if (offset > start) offset += 1;
          const text = renderInlineText(
            value,
            offset,
            highlights,
            `${key}-${rowIndex}-${cellIndex}`,
          );
          offset += value.length;
          return <td key={`${rowIndex}-${cellIndex}`}>{text}</td>;
        })}
      </tr>
    ));
    return (
      <div
        className="reader-table"
        key={key}
        tabIndex={0}
        aria-label="Article table"
      >
        <table>
          {header.length > 0 && (
            <thead>
              <tr>{header}</tr>
            </thead>
          )}
          <tbody>{rows}</tbody>
        </table>
      </div>
    );
  }
  if (block.type === "list") {
    let offset = start;
    const items = block.items.map((item, itemIndex) => {
      const rendered = renderInline(
        item,
        offset,
        highlights,
        `${key}-${itemIndex}`,
      );
      offset = rendered.end + (itemIndex + 1 < block.items.length ? 1 : 0);
      return <li key={`${key}-${itemIndex}`}>{rendered.nodes}</li>;
    });
    return block.ordered ? (
      <ol key={key}>{items}</ol>
    ) : (
      <ul key={key}>{items}</ul>
    );
  }
  const rendered = renderInline(block.children, start, highlights, key);
  if (block.type === "heading") {
    const Heading = `h${block.level}` as
      "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Heading key={key}>{rendered.nodes}</Heading>;
  }
  return block.type === "quote" ? (
    <blockquote key={key}>{rendered.nodes}</blockquote>
  ) : (
    <p key={key}>{rendered.nodes}</p>
  );
}

function renderedBlocks(
  content: ArticleContent,
  highlights: BookmarkHighlight[],
) {
  let offset = 0;
  let hasText = false;
  return content.blocks.map((block, index) => {
    const text = blockText(block);
    if (text && hasText) offset += 2;
    const node = renderArticleBlock(block, offset, highlights, index);
    if (text) {
      offset += text.length;
      hasText = true;
    }
    return node;
  });
}

export function BookmarkReader({
  bookmark,
  onClose,
  onChanged,
  onOpenNote,
}: {
  bookmark: Bookmark;
  onClose: () => void;
  onChanged: (bookmark: Bookmark) => void;
  onOpenNote?: (id: string) => Promise<boolean>;
}) {
  const confirm = useConfirm();
  const articleRoot = useRef<HTMLDivElement>(null);
  const selectedVersionRef = useRef<number | null>(null);
  const stateRequest = useRef<AbortController | null>(null);
  const articleRequest = useRef<AbortController | null>(null);
  const highlightsRequest = useRef<AbortController | null>(null);
  const versionRequest = useRef<AbortController | null>(null);
  const stateGeneration = useRef(0);
  const articleGeneration = useRef(0);
  const highlightGeneration = useRef(0);
  const [articleState, setArticleState] =
    useState<BookmarkArticleResult | null>(null);
  const [versionArticle, setVersionArticle] = useState<BookmarkArticle | null>(
    null,
  );
  const [versions, setVersions] = useState<VersionPage["items"]>([]);
  const [nextVersion, setNextVersion] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [loadingArticleVersion, setLoadingArticleVersion] = useState<
    number | null
  >(null);
  const [highlights, setHighlights] = useState<BookmarkHighlight[]>([]);
  const [highlightVersion, setHighlightVersion] = useState<number | null>(null);
  const [nextHighlight, setNextHighlight] = useState<string | null>(null);
  const [selection, setSelection] = useState<Anchor | null>(null);
  const [annotation, setAnnotation] = useState("");
  const [reanchorTarget, setReanchorTarget] =
    useState<BookmarkHighlight | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingState, setLoadingState] = useState(true);
  const [loadingHighlights, setLoadingHighlights] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [busyHighlight, setBusyHighlight] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"article" | "highlights">(
    "article",
  );
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const refreshState = useCallback(async () => {
    const controller = new AbortController();
    stateRequest.current?.abort();
    stateRequest.current = controller;
    const generation = ++stateGeneration.current;
    try {
      const [result, page] = await Promise.all([
        api<BookmarkArticleResult>(`bookmarks/${bookmark.id}/article`, {
          signal: controller.signal,
        }),
        api<VersionPage>(`bookmarks/${bookmark.id}/article/versions?limit=50`, {
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted || generation !== stateGeneration.current)
        return;
      setArticleState(result);
      setVersions(page.items);
      setNextVersion(page.next);
      if (selectedVersionRef.current === null && result.currentVersion > 0) {
        if (!result.article) setLoadingArticleVersion(result.currentVersion);
        selectedVersionRef.current = result.currentVersion;
        setSelectedVersion(result.currentVersion);
      }
      setError("");
    } catch (cause) {
      if (!controller.signal.aborted && generation === stateGeneration.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The saved article could not be loaded.",
        );
    } finally {
      if (!controller.signal.aborted && generation === stateGeneration.current)
        setLoadingState(false);
    }
  }, [bookmark.id]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshState();
    });
    return () => {
      cancelled = true;
      stateRequest.current?.abort();
      articleRequest.current?.abort();
      highlightsRequest.current?.abort();
      versionRequest.current?.abort();
    };
  }, [refreshState]);

  useEffect(() => {
    selectedVersionRef.current = selectedVersion;
  }, [selectedVersion]);

  const article =
    articleState?.article?.version === selectedVersion
      ? articleState.article
      : versionArticle?.version === selectedVersion
        ? versionArticle
        : null;

  useEffect(() => {
    if (
      selectedVersion === null ||
      articleState?.article?.version === selectedVersion ||
      versionArticle?.version === selectedVersion
    )
      return;
    const controller = new AbortController();
    articleRequest.current?.abort();
    articleRequest.current = controller;
    const generation = ++articleGeneration.current;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const result = await api<BookmarkArticleResult>(
          `bookmarks/${bookmark.id}/article?version=${selectedVersion}`,
          { signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          generation !== articleGeneration.current
        )
          return;
        if (!result.article)
          throw new Error("This saved article version is unavailable.");
        setVersionArticle(result.article);
        setError("");
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          generation === articleGeneration.current
        )
          setError(
            cause instanceof Error
              ? cause.message
              : "This article version could not be loaded.",
          );
      } finally {
        if (
          !controller.signal.aborted &&
          generation === articleGeneration.current
        )
          setLoadingArticleVersion((value) =>
            value === selectedVersion ? null : value,
          );
      }
    });
    return () => controller.abort();
  }, [articleState, bookmark.id, selectedVersion, versionArticle]);

  const loadHighlights = useCallback(
    async (version: number, append = false) => {
      const after =
        append && highlightVersion === version ? nextHighlight : null;
      if (append && !after) return;
      const controller = new AbortController();
      highlightsRequest.current?.abort();
      highlightsRequest.current = controller;
      const generation = ++highlightGeneration.current;
      const query = new URLSearchParams({
        limit: "50",
        version: String(version),
      });
      if (after) query.set("after", after);
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoadingHighlights(true);
      try {
        const page = await api<HighlightPage>(
          `bookmarks/${bookmark.id}/highlights?${query}`,
          { signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          generation !== highlightGeneration.current
        )
          return;
        setHighlights((current) =>
          append ? [...current, ...page.items] : page.items,
        );
        setHighlightVersion(version);
        setNextHighlight(page.next);
        setDrafts((current) => ({
          ...current,
          ...Object.fromEntries(
            page.items.map((item) => [item.id, item.annotation]),
          ),
        }));
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          generation === highlightGeneration.current
        )
          setError(
            cause instanceof Error
              ? cause.message
              : "Highlights could not be loaded.",
          );
      } finally {
        if (
          !controller.signal.aborted &&
          generation === highlightGeneration.current
        )
          setLoadingHighlights(false);
      }
    },
    [bookmark.id, highlightVersion, nextHighlight],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && selectedVersion !== null)
        void loadHighlights(selectedVersion);
    });
    return () => {
      cancelled = true;
    };
  }, [loadHighlights, selectedVersion]);

  useCompletion("bookmark", (event) => {
    if (event.target && event.target !== bookmark.id) return;
    void refreshState();
    if (selectedVersion !== null && event.status?.startsWith("highlight-"))
      void loadHighlights(selectedVersion);
  });

  const visibleHighlights = useMemo(
    () => (selectedVersion === highlightVersion ? highlights : []),
    [selectedVersion, highlightVersion, highlights],
  );
  const highlightedContent = useMemo(
    () =>
      article?.content
        ? renderedBlocks(article.content, visibleHighlights)
        : [],
    [article, visibleHighlights],
  );

  const captureSelection = useCallback(() => {
    const root = articleRoot.current;
    const current = article;
    const native = window.getSelection();
    if (
      !root ||
      !current ||
      !native ||
      native.isCollapsed ||
      native.rangeCount === 0
    ) {
      setSelection(null);
      return;
    }
    const range = native.getRangeAt(0);
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer)
    ) {
      setSelection(null);
      return;
    }
    const start = selectedPointOffset(
      root,
      range.startContainer,
      range.startOffset,
    );
    const end = selectedPointOffset(root, range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) {
      setSelection(null);
      return;
    }
    const startOffset = Math.min(start, end);
    const endOffset = Math.max(start, end);
    const fullText = articleText(current.content);
    const quote = fullText.slice(startOffset, endOffset);
    if (
      !quote.trim() ||
      normalizeSelection(quote) !== normalizeSelection(native.toString())
    ) {
      setSelection(null);
      return;
    }
    setSelection({
      articleVersion: current.version,
      quote,
      prefix: fullText.slice(Math.max(0, startOffset - 64), startOffset),
      suffix: fullText.slice(endOffset, endOffset + 64),
      startOffset,
      endOffset,
    });
  }, [article]);

  useEffect(() => {
    const update = () => {
      const current = window.getSelection();
      if (!current || current.isCollapsed || !articleRoot.current) return;
      if (articleRoot.current.contains(current.anchorNode)) captureSelection();
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [captureSelection]);

  async function syncBookmark() {
    try {
      const latest = await api<Bookmark>(`bookmarks/${bookmark.id}`);
      onChanged(latest);
    } catch {
      // Keep the reader state intact if the parent list has changed concurrently.
    }
  }

  async function requestArticle() {
    if (!articleState) return;
    const action =
      articleState.status === "ready"
        ? "refresh"
        : articleState.currentVersion > 0
          ? "retry"
          : "save";
    setRequestBusy(true);
    setError("");
    setStatus(
      action === "refresh"
        ? "Refreshing the saved article…"
        : "Saving the article…",
    );
    try {
      const result = await api<
        BookmarkArticleResult | { jobId: string; status: "pending" }
      >(`bookmarks/${bookmark.id}/article`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if ("currentVersion" in result) {
        setArticleState(result);
        if (result.article) {
          setVersionArticle(null);
          setLoadingArticleVersion(null);
          setSelectedVersion(result.article.version);
        }
      } else {
        setArticleState((current) =>
          current
            ? { ...current, status: "pending", jobId: result.jobId }
            : current,
        );
      }
      setStatus("Article processing has started.");
      await syncBookmark();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The article could not be saved.",
      );
      setStatus("");
    } finally {
      setRequestBusy(false);
    }
  }

  async function setReadState(read: boolean) {
    setReadBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await api<ReadStateResult>("bookmarks/read-state", {
        method: "POST",
        body: JSON.stringify({
          items: [{ id: bookmark.id, revision: bookmark.revision, read }],
        }),
      });
      const item = result.items[0];
      if (item?.bookmark) onChanged(item.bookmark);
      if (item?.status === "conflict")
        setError(
          "This bookmark changed elsewhere. Refresh it before changing its reading status.",
        );
      else if (item?.status === "not_found")
        setError("This bookmark is no longer available.");
      else setStatus(read ? "Marked as read." : "Marked as unread.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The reading status could not be updated.",
      );
    } finally {
      setReadBusy(false);
    }
  }

  async function saveSelection() {
    if (!selection) return;
    setSavingHighlight(true);
    setError("");
    try {
      if (reanchorTarget) {
        const updated = await api<BookmarkHighlight>(
          `bookmarks/${bookmark.id}/highlights/${reanchorTarget.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              revision: reanchorTarget.revision,
              reanchor: selection,
            }),
          },
        );
        setReanchorTarget(null);
        setHighlights((current) => [
          ...current.filter((item) => item.id !== updated.id),
          updated,
        ]);
        setDrafts((current) => ({
          ...current,
          [updated.id]: updated.annotation,
        }));
        setStatus("Highlight moved to this article version.");
      } else {
        const created = await api<BookmarkHighlight>(
          `bookmarks/${bookmark.id}/highlights`,
          {
            method: "POST",
            body: JSON.stringify({ ...selection, annotation }),
          },
        );
        setHighlights((current) => [created, ...current]);
        setDrafts((current) => ({
          ...current,
          [created.id]: created.annotation,
        }));
        setStatus("Highlight saved.");
      }
      setSelection(null);
      setAnnotation("");
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "This passage no longer matches the saved article. Select the exact text again."
          : cause instanceof Error
            ? cause.message
            : "The highlight could not be saved.",
      );
    } finally {
      setSavingHighlight(false);
    }
  }

  async function saveAnnotation(highlight: BookmarkHighlight) {
    const value = drafts[highlight.id] ?? highlight.annotation;
    if (value === highlight.annotation) return;
    setBusyHighlight(highlight.id);
    setError("");
    try {
      const updated = await api<BookmarkHighlight>(
        `bookmarks/${bookmark.id}/highlights/${highlight.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            revision: highlight.revision,
            annotation: value,
          }),
        },
      );
      setHighlights((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setStatus("Annotation saved.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError(
          "This highlight changed elsewhere. Reload it before saving your annotation.",
        );
        if (selectedVersion !== null) void loadHighlights(selectedVersion);
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "The annotation could not be saved.",
        );
    } finally {
      setBusyHighlight(null);
    }
  }

  async function deleteHighlight(highlight: BookmarkHighlight) {
    const confirmed = await confirm({
      title: "Delete this highlight?",
      description: "The saved article will remain unchanged.",
      action: "Delete highlight",
    });
    if (!confirmed) return;
    setBusyHighlight(highlight.id);
    setError("");
    try {
      await api(`bookmarks/${bookmark.id}/highlights/${highlight.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: highlight.revision }),
      });
      setHighlights((current) =>
        current.filter((item) => item.id !== highlight.id),
      );
      setStatus("Highlight deleted.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError(
          "This highlight changed elsewhere. Reload it before deleting.",
        );
        if (selectedVersion !== null) void loadHighlights(selectedVersion);
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "The highlight could not be deleted.",
        );
    } finally {
      setBusyHighlight(null);
    }
  }

  async function saveQuoteAsNote(highlight: BookmarkHighlight) {
    setNoteBusy(highlight.id);
    setError("");
    const annotationText = highlight.annotation.trim();
    const source = `Source: ${bookmark.title}\n${bookmark.url}`;
    const document = {
      schemaVersion: 1,
      blocks: [
        {
          type: "quote",
          content: [{ type: "text", text: highlight.quote, styles: {} }],
        },
        ...(annotationText
          ? [
              {
                type: "paragraph",
                content: [{ type: "text", text: annotationText, styles: {} }],
              },
            ]
          : []),
        {
          type: "paragraph",
          content: [{ type: "text", text: source, styles: {} }],
        },
      ],
    };
    try {
      const note = await api<Note>("notes", {
        method: "POST",
        body: JSON.stringify({
          title: `Quote from ${bookmark.title}`.slice(0, 300),
          document,
        }),
      });
      setStatus("Quote saved as a note.");
      if (onOpenNote) {
        const opened = await onOpenNote(note.id);
        if (!opened)
          setError("The note was saved, but could not be opened right now.");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The quote could not be saved as a note.",
      );
    } finally {
      setNoteBusy(null);
    }
  }

  async function loadOlderVersions() {
    if (!nextVersion || loadingVersions) return;
    versionRequest.current?.abort();
    const controller = new AbortController();
    versionRequest.current = controller;
    setLoadingVersions(true);
    const query = new URLSearchParams({ limit: "50", after: nextVersion });
    try {
      const page = await api<VersionPage>(
        `bookmarks/${bookmark.id}/article/versions?${query}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setVersions((current) => [...current, ...page.items]);
        setNextVersion(page.next);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Older versions could not be loaded.",
        );
    } finally {
      if (!controller.signal.aborted) setLoadingVersions(false);
    }
  }

  function beginReanchor(highlight: BookmarkHighlight) {
    const newest = articleState?.currentVersion ?? 0;
    if (!newest || highlight.articleVersion === newest) return;
    setReanchorTarget(highlight);
    setSelection(null);
    setSelectedVersion(newest);
    setStatus(
      "Select the matching passage in the current version, then move the highlight there.",
    );
    setMobilePane("article");
  }

  function scrollToHighlight(id: string) {
    requestAnimationFrame(() => {
      const mark = [
        ...(articleRoot.current?.querySelectorAll<HTMLElement>(
          "[data-highlight-ids]",
        ) ?? []),
      ].find((node) => node.dataset.highlightIds?.split(" ").includes(id));
      mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  const currentVersion =
    articleState?.currentVersion ?? bookmark.articleVersion;
  const loadingArticle =
    selectedVersion !== null && loadingArticleVersion === selectedVersion;
  const articlePending = articleState?.status === "pending";
  const activeReadState = bookmark.readAt !== null;
  const canSaveArticle = !loadingState && !requestBusy && !articlePending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="bookmark-reader-dialog left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:left-1/2 sm:top-1/2 sm:h-[min(88dvh,900px)] sm:w-[min(1100px,calc(100vw-48px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
      >
        <DialogTitle className="sr-only">
          Saved article: {bookmark.title}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Read the saved article, highlight passages and keep private notes.
        </DialogDescription>
        <header className="bookmark-reader-header shrink-0 border-b px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold leading-6 sm:text-lg">
                {bookmark.title || bookmark.url}
              </h2>
              <a
                href={bookmark.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                <span className="truncate">
                  {bookmarkHostname(bookmark.url)}
                </span>
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                <span className="sr-only">Open original article</span>
              </a>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-lg"
              className="min-h-11 min-w-11 md:hidden"
              aria-label={
                activeReadState ? "Mark bookmark unread" : "Mark bookmark read"
              }
              disabled={readBusy}
              onClick={() => void setReadState(!activeReadState)}
            >
              {readBusy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : activeReadState ? (
                <Check aria-hidden="true" />
              ) : (
                <FileText aria-hidden="true" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-lg"
              className="min-h-11 min-w-11"
              aria-label="Close saved article"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="bookmark-reading-controls shrink-0 border-b px-4 py-2 sm:px-6">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {versions.length > 0 && (
                <Select
                  value={
                    selectedVersion === null
                      ? undefined
                      : String(selectedVersion)
                  }
                  onValueChange={(value) => {
                    const version = Number(value);
                    if (Number.isSafeInteger(version)) {
                      const alreadyLoaded =
                        articleState?.article?.version === version ||
                        versionArticle?.version === version;
                      setLoadingArticleVersion(alreadyLoaded ? null : version);
                      setSelectedVersion(version);
                      setSelection(null);
                      setAnnotation("");
                      setReanchorTarget(null);
                      setError("");
                    }
                  }}
                >
                  <SelectTrigger
                    className="h-10 w-[min(100%,240px)]"
                    aria-label="Article version"
                  >
                    <SelectValue placeholder="Choose a version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((version) => (
                      <SelectItem
                        key={version.version}
                        value={String(version.version)}
                      >
                        <span className="truncate">
                          Version {version.version} ·{" "}
                          {displayDate(version.capturedAt)}
                          {version.version === articleState?.currentVersion
                            ? " · Current"
                            : ""}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {nextVersion && (
                <Button
                  variant="ghost"
                  className="min-h-10"
                  disabled={loadingVersions}
                  onClick={() => void loadOlderVersions()}
                >
                  {loadingVersions ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : null}
                  Older versions
                </Button>
              )}
              <Button
                variant="outline"
                className="min-h-10"
                disabled={!canSaveArticle}
                onClick={() => void requestArticle()}
              >
                {requestBusy || articlePending ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCw aria-hidden="true" />
                )}
                {articlePending
                  ? "Saving article…"
                  : articleState?.status === "ready"
                    ? "Refresh article"
                    : articleState?.currentVersion
                      ? "Retry article"
                      : "Save article"}
              </Button>
              <span
                className="bookmark-reader-status hidden text-xs sm:inline"
                aria-live="polite"
              >
                {articleState?.status === "ready"
                  ? "Saved article"
                  : articlePending
                    ? "Preparing article"
                    : "Article not saved"}
              </span>
            </div>
            <div className="hidden items-center gap-1 md:flex">
              <Button
                variant={activeReadState ? "secondary" : "ghost"}
                className="min-h-10"
                disabled={readBusy}
                aria-pressed={activeReadState}
                onClick={() => void setReadState(!activeReadState)}
              >
                {activeReadState ? "Read" : "Mark read"}
              </Button>
            </div>
          </div>

          <div
            className="flex gap-1 border-b px-4 py-1 md:hidden"
            role="group"
            aria-label="Reader view"
          >
            <Button
              variant={mobilePane === "article" ? "secondary" : "ghost"}
              className="min-h-10 flex-1"
              aria-pressed={mobilePane === "article"}
              onClick={() => setMobilePane("article")}
            >
              Article
            </Button>
            <Button
              variant={mobilePane === "highlights" ? "secondary" : "ghost"}
              className="min-h-10 flex-1"
              aria-pressed={mobilePane === "highlights"}
              onClick={() => setMobilePane("highlights")}
            >
              Highlights{highlights.length ? ` · ${highlights.length}` : ""}
            </Button>
          </div>

          {(error || status) && (
            <div
              className="shrink-0 px-4 pt-3 sm:px-6"
              aria-live={error ? "assertive" : "polite"}
            >
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{status}</p>
              )}
            </div>
          )}

          <div className="grid min-h-0 flex-1 grid-cols-1 pb-[env(safe-area-inset-bottom)] md:grid-cols-[minmax(0,1fr)_300px]">
            <section
              className={`min-h-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7 ${mobilePane === "article" ? "block" : "hidden md:block"}`}
              aria-label="Saved article content"
            >
              {loadingState || loadingArticle ? (
                <div
                  className="bookmark-reader-status flex min-h-48 flex-col items-center justify-center gap-3"
                  role="status"
                >
                  <LoaderCircle
                    className="size-5 animate-spin"
                    aria-hidden="true"
                  />
                  <span>
                    {loadingState
                      ? "Loading saved article…"
                      : "Loading this version…"}
                  </span>
                </div>
              ) : article ? (
                <div className="bookmark-reader">
                  <div className="mx-auto w-full max-w-[740px]">
                    <div className="mb-6 border-b pb-4">
                      <h1 className="text-2xl font-semibold leading-tight tracking-tight">
                        {article.title || bookmark.title}
                      </h1>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {article.byline ? (
                          <>
                            {article.byline}
                            <span aria-hidden="true"> · </span>
                          </>
                        ) : null}
                        Saved {displayDate(article.capturedAt)}
                      </p>
                    </div>
                    {reanchorTarget && (
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                        <p>
                          Select the exact passage for “
                          {reanchorTarget.quote.slice(0, 80)}
                          {reanchorTarget.quote.length > 80 ? "…" : ""}”.
                        </p>
                        <Button
                          variant="ghost"
                          className="min-h-10"
                          onClick={() => {
                            setReanchorTarget(null);
                            setSelection(null);
                            setStatus("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                    {selection && (
                      <div
                        className="bookmark-reader-toolbar sticky top-0 z-10 mb-4 rounded-md border bg-background p-3"
                        aria-label="Selected passage actions"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {reanchorTarget
                              ? "Move this highlight"
                              : "Selected passage"}
                          </p>
                          <blockquote className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {selection.quote}
                          </blockquote>
                        </div>
                        {!reanchorTarget && (
                          <label className="w-full sm:w-64">
                            <span className="sr-only">
                              Highlight annotation
                            </span>
                            <Textarea
                              value={annotation}
                              maxLength={3000}
                              rows={2}
                              placeholder="Add a note (optional)"
                              onChange={(event) =>
                                setAnnotation(event.target.value)
                              }
                            />
                          </label>
                        )}
                        <Button
                          className="min-h-11"
                          disabled={savingHighlight}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void saveSelection()}
                        >
                          {savingHighlight ? (
                            <LoaderCircle
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : reanchorTarget ? (
                            <ArrowDownToLine aria-hidden="true" />
                          ) : (
                            <Highlighter aria-hidden="true" />
                          )}
                          {reanchorTarget ? "Move highlight" : "Save highlight"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className="min-h-11 min-w-11"
                          aria-label="Cancel selected passage"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setSelection(null);
                            window.getSelection()?.removeAllRanges();
                          }}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                    <article
                      ref={articleRoot}
                      className="bookmark-reader-content mx-auto whitespace-pre-wrap"
                      onMouseUp={captureSelection}
                      onKeyUp={captureSelection}
                    >
                      {highlightedContent}
                    </article>
                    {article.text !== articleText(article.content) && (
                      <p className="sr-only">
                        Article text is available in search.
                      </p>
                    )}
                  </div>
                </div>
              ) : articleState?.status === "pending" ? (
                <div
                  className="bookmark-reader-status mx-auto flex min-h-48 max-w-md flex-col items-center justify-center gap-3 text-center"
                  role="status"
                >
                  <LoaderCircle
                    className="size-5 animate-spin"
                    aria-hidden="true"
                  />
                  <p className="font-medium">Preparing your article</p>
                  <p className="text-sm">
                    You can keep using Nivra while this finishes.
                  </p>
                </div>
              ) : (
                <div className="mx-auto flex min-h-48 max-w-md flex-col items-center justify-center gap-3 text-center">
                  <FileText
                    className="size-6 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h3 className="font-medium">No saved article yet</h3>
                  <p className="text-sm text-muted-foreground">
                    Save a readable copy to keep the article and its highlights
                    together.
                  </p>
                  <Button
                    className="min-h-11"
                    disabled={!canSaveArticle}
                    onClick={() => void requestArticle()}
                  >
                    {requestBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <FileText aria-hidden="true" />
                    )}
                    {articleState?.currentVersion
                      ? "Retry saving article"
                      : "Save article"}
                  </Button>
                </div>
              )}
            </section>

            <aside
              className={`min-h-0 overflow-y-auto border-l px-4 py-5 sm:px-5 ${mobilePane === "highlights" ? "block" : "hidden md:block"}`}
              aria-label="Saved highlights"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Highlights</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Passages saved from this version.
                  </p>
                </div>
                {loadingHighlights && (
                  <LoaderCircle
                    className="size-4 animate-spin text-muted-foreground"
                    aria-label="Loading highlights"
                  />
                )}
              </div>
              {highlights.length === 0 && !loadingHighlights ? (
                <p className="text-sm text-muted-foreground">
                  Select a passage in the article to save a highlight.
                </p>
              ) : (
                <div className="bookmark-highlight-list">
                  {highlights.map((highlight) => (
                    <article key={highlight.id} className="bookmark-highlight">
                      <button
                        type="button"
                        className="min-w-0 text-left text-sm font-medium leading-6 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          setMobilePane("article");
                          scrollToHighlight(highlight.id);
                        }}
                      >
                        “{highlight.quote}”
                      </button>
                      <Textarea
                        value={drafts[highlight.id] ?? highlight.annotation}
                        maxLength={3000}
                        rows={2}
                        aria-label={`Annotation for highlight: ${highlight.quote.slice(0, 60)}`}
                        placeholder="Add a note"
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [highlight.id]: event.target.value,
                          }))
                        }
                      />
                      <div className="bookmark-highlight-actions">
                        {drafts[highlight.id] !== highlight.annotation && (
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={busyHighlight === highlight.id}
                            onClick={() => void saveAnnotation(highlight)}
                          >
                            {busyHighlight === highlight.id ? (
                              <LoaderCircle
                                className="animate-spin"
                                aria-hidden="true"
                              />
                            ) : null}
                            Save note
                          </Button>
                        )}
                        {highlight.articleVersion !== currentVersion &&
                          articleState?.status === "ready" && (
                            <Button
                              variant="ghost"
                              className="min-h-11"
                              onClick={() => beginReanchor(highlight)}
                            >
                              Move to current version
                            </Button>
                          )}
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className="min-h-11 min-w-11"
                          aria-label="Save highlight as a note"
                          disabled={noteBusy === highlight.id}
                          onClick={() => void saveQuoteAsNote(highlight)}
                        >
                          {noteBusy === highlight.id ? (
                            <LoaderCircle
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <StickyNote aria-hidden="true" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
                          aria-label="Delete highlight"
                          disabled={busyHighlight === highlight.id}
                          onClick={() => void deleteHighlight(highlight)}
                        >
                          {busyHighlight === highlight.id ? (
                            <LoaderCircle
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <Trash2 aria-hidden="true" />
                          )}
                        </Button>
                      </div>
                    </article>
                  ))}
                  {nextHighlight && (
                    <Button
                      variant="outline"
                      className="min-h-11 w-full"
                      disabled={loadingHighlights || selectedVersion === null}
                      onClick={() =>
                        selectedVersion !== null &&
                        void loadHighlights(selectedVersion, true)
                      }
                    >
                      {loadingHighlights && (
                        <LoaderCircle
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      Load older highlights
                    </Button>
                  )}
                </div>
              )}
            </aside>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
