import { createHash } from "node:crypto";
import { parse as parseHtml } from "parse5";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

type Inline =
  | { type: "text"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "strong" | "emphasis" | "code"; children: Inline[] };
type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph" | "quote"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "code-block"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "rule" };

const maxHtmlBytes = 2 * 1024 * 1024;
const maxDomNodes = 50_000;
const maxTextLength = 200_000;

function visibleText(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function countNodes(node: unknown, state: { nodes: number; chars: number }) {
  if (!node || typeof node !== "object") return;
  state.nodes++;
  if (state.nodes > maxDomNodes)
    throw new Error("Article has too many elements.");
  const record = node as { value?: unknown; childNodes?: unknown[] };
  if (typeof record.value === "string") {
    state.chars += record.value.length;
    if (state.chars > maxHtmlBytes)
      throw new Error("Article source text is too large.");
  }
  if (Array.isArray(record.childNodes))
    for (const child of record.childNodes) countNodes(child, state);
}

function inline(node: Node, baseUrl: string, depth = 0): Inline[] {
  if (depth > 20) throw new Error("Article nesting is too deep.");
  if (node.nodeType === node.TEXT_NODE) {
    const text = visibleText(node.textContent || "");
    return text ? [{ type: "text", text }] : [];
  }
  if (node.nodeType !== node.ELEMENT_NODE) return [];
  const element = node as Element;
  const name = element.tagName.toLowerCase();
  if (["script", "style", "template", "noscript", "svg", "math"].includes(name))
    return [];
  if (element.childNodes.length > 256)
    throw new Error("Article has too many inline elements.");
  const children = Array.from(element.childNodes).flatMap((child) =>
    inline(child, baseUrl, depth + 1),
  );
  if (name === "a") {
    try {
      const href = new URL(element.getAttribute("href") || "", baseUrl);
      if (
        ["http:", "https:"].includes(href.protocol) &&
        !href.username &&
        !href.password
      )
        return [{ type: "link", href: href.href.slice(0, 4096), children }];
    } catch {
      return children;
    }
    return children;
  }
  if (["strong", "b"].includes(name))
    return children.length ? [{ type: "strong", children }] : [];
  if (["em", "i"].includes(name))
    return children.length ? [{ type: "emphasis", children }] : [];
  if (["code", "kbd", "samp"].includes(name))
    return children.length ? [{ type: "code", children }] : [];
  return children;
}

function plain(inlines: Inline[]): string {
  return inlines
    .map((item) =>
      item.type === "text"
        ? item.text
        : item.type === "link"
          ? plain(item.children)
          : plain(item.children),
    )
    .join("");
}

function cellText(cell: Element) {
  return visibleText(cell.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function toBlocks(root: Element, baseUrl: string): Block[] {
  const output: Block[] = [];
  let overflow = false;
  const push = (block: Block) => {
    if (output.length >= 5000) overflow = true;
    else output.push(block);
  };
  const pushInline = (type: "paragraph" | "quote", element: Element) => {
    const children = Array.from(element.childNodes).flatMap((child) =>
      inline(child, baseUrl),
    );
    if (plain(children).trim()) push({ type, children });
  };
  const walk = (element: Element, depth = 0) => {
    if (depth > 30) return;
    for (const child of Array.from(element.children)) {
      if (output.length >= 5000) return;
      const name = child.tagName.toLowerCase();
      if (
        [
          "script",
          "style",
          "template",
          "noscript",
          "svg",
          "math",
          "figure",
        ].includes(name)
      )
        continue;
      if (/^h[1-6]$/.test(name)) {
        const children = Array.from(child.childNodes).flatMap((node) =>
          inline(node, baseUrl),
        );
        if (plain(children).trim())
          push({ type: "heading", level: Number(name[1]), children });
      } else if (name === "p") pushInline("paragraph", child);
      else if (name === "blockquote") pushInline("quote", child);
      else if (name === "pre") {
        const text = visibleText(child.textContent || "").slice(0, 200_000);
        if (text.trim()) push({ type: "code-block", text });
      } else if (name === "ul" || name === "ol") {
        const items = Array.from(child.children)
          .filter((item) => item.tagName.toLowerCase() === "li")
          .slice(0, 500)
          .map((item) =>
            Array.from(item.childNodes).flatMap((node) =>
              inline(node, baseUrl),
            ),
          );
        if (items.length) push({ type: "list", ordered: name === "ol", items });
      } else if (name === "table") {
        const rows = Array.from(child.querySelectorAll("tr"));
        const headerRow = rows.find((row) => row.querySelector("th"));
        const header = headerRow
          ? Array.from(headerRow.querySelectorAll("th,td"))
              .slice(0, 32)
              .map(cellText)
          : [];
        const body = rows
          .filter((row) => row !== headerRow)
          .slice(0, 500)
          .map((row) =>
            Array.from(row.querySelectorAll("th,td"))
              .slice(0, 32)
              .map(cellText),
          );
        if (header.length || body.length)
          push({ type: "table", header, rows: body });
      } else if (name === "hr") push({ type: "rule" });
      else if (child.children.length) walk(child, depth + 1);
      else pushInline("paragraph", child);
    }
  };
  walk(root);
  if (overflow) throw new Error("Article has too many content blocks.");
  return output;
}

function blockText(block: Block): string {
  if (block.type === "rule") return "";
  if (block.type === "code-block") return block.text;
  if (block.type === "table")
    return [...block.header, ...block.rows.flat()].join(" ");
  if (block.type === "list") return block.items.map(plain).join("\n");
  return plain(block.children);
}

function extract(input: { html: string; url: string; fallbackTitle: string }) {
  const bytes = Buffer.byteLength(input.html, "utf8");
  if (!bytes || bytes > maxHtmlBytes)
    throw new Error("Article source is outside the size limit.");
  const parsed = parseHtml(input.html);
  countNodes(parsed, { nodes: 0, chars: 0 });
  const dom = new JSDOM(input.html, { url: input.url });
  try {
    const result = new Readability(dom.window.document, {
      maxElemsToParse: maxDomNodes,
      charThreshold: 80,
      disableJSONLD: true,
    }).parse();
    if (!result) throw new Error("No readable article was found.");
    const contentDom = new JSDOM(`<body>${result.content}</body>`, {
      url: input.url,
    });
    try {
      const body = contentDom.window.document.body;
      const blocks = toBlocks(body, input.url);
      const text = blocks.map(blockText).filter(Boolean).join("\n\n");
      if (!text.trim()) throw new Error("No readable article text was found.");
      if (text.length > maxTextLength)
        throw new Error("Article text exceeds the save limit.");
      const content = { blocks };
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            title: result.title || input.fallbackTitle,
            byline: result.byline,
            content,
          }),
        )
        .digest("hex");
      return {
        url: input.url,
        title: visibleText(result.title || input.fallbackTitle)
          .trim()
          .slice(0, 300),
        byline: result.byline
          ? visibleText(result.byline).trim().slice(0, 200)
          : null,
        content,
        text,
        fingerprint,
      };
    } finally {
      contentDom.window.close();
    }
  } finally {
    dom.window.close();
  }
}

process.on("message", (message: unknown) => {
  try {
    const result = extract(
      message as { html: string; url: string; fallbackTitle: string },
    );
    process.send?.({ result });
  } catch {
    process.send?.({ error: "This page could not be saved as an article." });
  }
});
