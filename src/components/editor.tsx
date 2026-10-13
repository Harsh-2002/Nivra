"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  type PartialBlock,
} from "@blocknote/core";
import {
  createReactBlockSpec,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/shadcn";
import { syntaxHighlighter } from "@blocknote/code-block";
import { locales as diagramLocales } from "@blocknote/diagram-block";
import * as locales from "@blocknote/core/locales";
import { PencilLine, Download, Loader2, FileText } from "lucide-react";
import { Button } from "./ui/button";
import { codeBlockSpec } from "./code-block";
import { checklistBlockSpec } from "./checklist-block";
import {
  TaskLinkActionsContext,
  taskLinkBlockSpec,
  type TaskLinkActions,
} from "./task-link-block";
import { audioBlockSpec, videoBlockSpec } from "./media-blocks";
import { download } from "@/lib/client";
import { apiItems } from "@/lib/client";
import { canonicalizeTaskLinks } from "@/lib/writing";
import { notify } from "@/lib/feedback";
import { mediaUrl } from "@/lib/media-url";
import { diagramBlockSpec } from "./diagram-block";
import { useCspNonce } from "@/lib/csp";
import type { Document, NoteSummary } from "@/lib/types";
import { findSearchBlock } from "@/lib/search-context";
import "@blocknote/shadcn/style.css";

const CanvasDialog = dynamic(() => import("./canvas-dialog"), {
  ssr: false,
  loading: () => (
    <div className="canvas-loading">
      <Loader2 className="animate-spin" />
      Opening drawing tools…
    </div>
  ),
});
function CanvasPreview({
  scene,
  preview,
  onChange,
}: {
  scene: string;
  preview: string;
  onChange: (scene: string, preview: string) => void;
}) {
  const [open, setOpen] = useState(false);
  async function exportDrawing() {
    const data = JSON.parse(
      scene ||
        '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
    );
    for (const file of Object.values(data.files || {}) as {
      dataURL?: string;
      attachmentId?: string;
    }[]) {
      if (file.attachmentId) {
        const blob = await fetch(`/api/v1/files/${file.attachmentId}`).then(
          (r) => r.blob(),
        );
        file.dataURL = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        });
        delete file.attachmentId;
      }
    }
    download(
      new Blob([JSON.stringify(data)], { type: "application/json" }),
      "drawing.excalidraw",
    );
  }
  return (
    <div className="drawing-block" contentEditable={false}>
      <button
        className="drawing-preview"
        onClick={() => setOpen(true)}
        aria-label="Edit drawing"
      >
        {preview ? (
          <img src={mediaUrl(preview)} alt="Drawing preview" />
        ) : (
          <span>
            <PencilLine size={28} />A blank canvas for your ideas
            <span>Click to start drawing</span>
          </span>
        )}
      </button>
      <div className="drawing-actions">
        <span>
          <PencilLine size={14} />
          Drawing
        </span>
        <Button size="sm" variant="ghost" onClick={exportDrawing}>
          <Download size={14} />
          Download
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Edit drawing
        </Button>
      </div>
      {open && (
        <CanvasDialog
          scene={scene}
          onClose={() => setOpen(false)}
          onSave={(data, image) => {
            onChange(data, image);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
const canvasSpec = createReactBlockSpec(
  {
    type: "canvas",
    propSchema: { scene: { default: "" }, preview: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) =>
      editor.isEditable ? (
        <CanvasPreview
          scene={block.props.scene}
          preview={block.props.preview}
          onChange={(scene, preview) =>
            editor.updateBlock(block, { props: { scene, preview } })
          }
        />
      ) : (
        <div className="drawing-block">
          {block.props.preview ? (
            <img src={block.props.preview} alt="Drawing" />
          ) : (
            <p>Drawing preview unavailable</p>
          )}
        </div>
      ),
    toExternalHTML: ({ block }) => (
      <div>
        {block.props.preview ? (
          <img src={block.props.preview} alt="Drawing" />
        ) : (
          <p>Drawing</p>
        )}
      </div>
    ),
  },
);
export const editorSchema = BlockNoteSchema.create().extend({
  blockSpecs: {
    codeBlock: codeBlockSpec,
    checkListItem: checklistBlockSpec,
    taskLink: taskLinkBlockSpec,
    diagram: diagramBlockSpec,
    canvas: canvasSpec(),
    audio: audioBlockSpec,
    video: videoBlockSpec,
  },
});
type Blocks = PartialBlock<
  typeof editorSchema.blockSchema,
  typeof editorSchema.inlineContentSchema,
  typeof editorSchema.styleSchema
>[];
export async function markdownDocument(markdown: string): Promise<Document> {
  const editor = BlockNoteEditor.create({ schema: editorSchema });
  const blocks = editor.tryParseMarkdownToBlocks(markdown);
  editor.replaceBlocks(editor.document, blocks);
  return {
    schemaVersion: 1,
    blocks: editor.document as unknown as Document["blocks"],
  };
}
export type TaskSelection = {
  blockId: string;
  selectedText?: string;
  title: string;
};
export type EditorTools = {
  markdown: () => string;
  taskSelection: () => TaskSelection | null;
  syncDocument: (document: Document) => void;
  getDocument: () => Document;
  matchesDocument: (document: Document) => boolean;
  insertDocument: (blocks: Document["blocks"]) => void;
};

function documentSignature(value: unknown) {
  const canonical = canonicalizeTaskLinks(value);
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  };
  return JSON.stringify(stable(canonical));
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { text?: unknown; content?: unknown };
      if (typeof item.text === "string") return item.text;
      return textFrom(item.content);
    })
    .join("");
}
export default function Editor({
  document,
  onChange,
  onTools,
  editable,
  noteId,
  onOpenNote,
  taskLinkActions,
  allowUpload = true,
  contentLabel,
  focusTerms,
}: {
  document: Document;
  onChange: (document: Document) => void;
  onTools: (tools: EditorTools) => void;
  editable: boolean;
  noteId: string;
  onOpenNote?: (id: string) => Promise<boolean>;
  taskLinkActions?: TaskLinkActions;
  allowUpload?: boolean;
  contentLabel?: string;
  focusTerms?: string[];
}) {
  const { resolvedTheme } = useTheme();
  const nonce = useCspNonce();
  const editor = useCreateBlockNote({
    schema: editorSchema,
    domAttributes: {
      editor: {
        "aria-label":
          contentLabel ?? (editable ? "Note content" : "Shared note content"),
        "aria-multiline": "true",
      },
    },
    initialContent: document.blocks as Blocks,
    extensions: [syntaxHighlighter],
    _tiptapOptions: { injectNonce: nonce },
    resolveFileUrl: async (url) => mediaUrl(url),
    dictionary: {
      ...locales.en,
      placeholders: { ...locales.en.placeholders, default: "Start writing…" },
      diagram: diagramLocales.en,
    },
    uploadFile: async (file) => {
      if (!allowUpload)
        throw new Error("Attachments cannot be added to a template here.");
      const form = new FormData();
      form.set("file", file);
      form.set("note", noteId);
      const result = await fetch("/api/v1/files", {
        method: "POST",
        body: form,
      });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error);
      return data.url;
    },
  });
  const suppressedDocument = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTerms?.length) return;
    const frame = requestAnimationFrame(() => {
      const id = findSearchBlock(
        editor.document as unknown as Document["blocks"],
        focusTerms,
      );
      if (!id || !editor.getBlock(id)) return;
      const node = editor.domElement?.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(id)}"]`,
      );
      if (!node) return;
      node.scrollIntoView({ block: "center", behavior: "instant" });
      if (editor.isEditable) {
        editor.setTextCursorPosition(id, "start");
        editor.focus();
      }
      node.classList.add("search-block-target");
      node.addEventListener(
        "animationend",
        () => node.classList.remove("search-block-target"),
        { once: true },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, focusTerms]);
  useEffect(() => {
    const element = editor.domElement;
    if (!element) return;
    // BlockNote's suggestion menu adds aria-expanded to a textbox, where it is invalid.
    const normalize = () => element.removeAttribute("aria-expanded");
    normalize();
    const observer = new MutationObserver(normalize);
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    return () => observer.disconnect();
  }, [editor]);
  useEffect(() => {
    onTools({
      taskSelection: () => {
        const selectedText = editor.getSelectedText().trim();
        const selection = editor.getSelection();
        const selectedBlock =
          selection?.blocks.length === 1 ? selection.blocks[0] : undefined;
        const cursorBlock = editor.getTextCursorPosition().block;
        const target = selectedText ? selectedBlock : cursorBlock;
        if (!target || (!selectedText && cursorBlock.type !== "checkListItem"))
          return null;
        return {
          blockId: target.id,
          ...(selectedText ? { selectedText } : {}),
          title: (selectedText || textFrom(target.content)).trim(),
        };
      },
      syncDocument: (next) => {
        suppressedDocument.current = documentSignature(next);
        editor.replaceBlocks(
          editor.document.map((block) => block.id),
          next.blocks as Blocks,
        );
      },
      getDocument: () => ({
        schemaVersion: 1,
        blocks: editor.document as unknown as Document["blocks"],
      }),
      matchesDocument: (candidate) =>
        documentSignature(candidate) ===
        documentSignature({
          schemaVersion: 1,
          blocks: editor.document as unknown as Document["blocks"],
        }),
      insertDocument: (blocks) => {
        if (!editor.isEditable || !blocks.length) return;
        editor.insertBlocks(
          blocks as Blocks,
          editor.getTextCursorPosition().block,
          "after",
        );
        editor.focus();
      },
      markdown: () => {
        const convert = (blocks: typeof editor.document): string =>
          blocks
            .map((block) => {
              if (block.type === "canvas")
                return `${block.props.preview ? `![Drawing](${block.props.preview})\n\n` : ""}[Editable drawing](drawings/${block.id}.excalidraw)\n\n`;
              if (block.type === "taskLink")
                return `- [${block.props.fallbackChecked ? "x" : " "}] ${block.props.fallbackTitle || "Linked task"}`;
              return editor.blocksToMarkdownLossy([block]);
            })
            .join("\n");
        return convert(editor.document);
      },
    });
  }, [editor, onTools]);
  const insert = (type: "canvas") => {
    editor.insertBlocks(
      [{ type }],
      editor.getTextCursorPosition().block,
      "after",
    );
    editor.focus();
  };
  return (
    <div
      className="editor-root"
      onClickCapture={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        const match = link
          ?.getAttribute("href")
          ?.match(/^\/\?note=([a-f0-9-]{36})$/);
        if (match && onOpenNote && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          void onOpenNote(match[1]);
        }
      }}
      onKeyDownCapture={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        const match = link
          ?.getAttribute("href")
          ?.match(/^\/\?note=([a-f0-9-]{36})$/);
        if (event.key === "Enter" && match && onOpenNote) {
          event.preventDefault();
          event.stopPropagation();
          void onOpenNote(match[1]);
        }
      }}
    >
      <TaskLinkActionsContext.Provider value={taskLinkActions ?? null}>
        <BlockNoteView
          editor={editor}
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          editable={editable}
          formattingToolbar={editable}
          sideMenu={editable}
          slashMenu={false}
          onChange={() => {
            const next = {
              schemaVersion: 1 as const,
              blocks: editor.document as unknown as Document["blocks"],
            };
            const serialized = documentSignature(next);
            if (suppressedDocument.current === serialized) {
              suppressedDocument.current = null;
              return;
            }
            if (documentSignature(document) === serialized) return;
            onChange(next);
          }}
        >
          {editable && (
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) =>
                filterSuggestionItems(
                  [
                    ...getDefaultReactSlashMenuItems(editor).filter((item) =>
                      allowUpload
                        ? true
                        : !/image|file|video|audio|upload/i.test(
                            `${item.title} ${item.subtext || ""} ${item.group}`,
                          ),
                    ),
                    {
                      title: "Drawing",
                      subtext: "Sketch on a freeform canvas",
                      group: "Artifacts",
                      icon: <PencilLine size={18} />,
                      aliases: ["canvas", "excalidraw", "draw"],
                      onItemClick: () => insert("canvas"),
                    },
                  ],
                  query,
                )
              }
            />
          )}
          {editable && (
            <SuggestionMenuController
              triggerCharacter="[["
              getItems={async (query) => {
                const notes = await apiItems<NoteSummary>(
                  `notes?limit=20&q=${encodeURIComponent(query)}`,
                ).catch(() => {
                  notify.error(
                    "Could not find notes. Try linking again when connected.",
                  );
                  return [];
                });
                return notes
                  .filter((note) => note.id !== noteId)
                  .map((note) => ({
                    title: note.title || "Untitled",
                    subtext: note.text.slice(0, 80),
                    group: "Link a note",
                    icon: <FileText size={16} />,
                    onItemClick: () =>
                      editor.insertInlineContent([
                        {
                          type: "link",
                          href: `/?note=${note.id}`,
                          content: [
                            {
                              type: "text",
                              text: note.title || "Untitled",
                              styles: {},
                            },
                          ],
                        },
                        " ",
                      ]),
                  }));
              }}
            />
          )}
        </BlockNoteView>
      </TaskLinkActionsContext.Provider>
    </div>
  );
}
