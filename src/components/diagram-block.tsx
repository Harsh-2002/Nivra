"use client";
import {
  createBlockConfig,
  parsePreCodeContent,
  plainContentToString,
} from "@blocknote/core";
import { createReactBlockSpec, SourceBlockWithPreview } from "@blocknote/react";
import { ReaderDiagram } from "./reader-artifacts";

// Adapted from BlockNote's diagram block (MPL-2.0) without importing its package, whose entry loads Mermaid eagerly.
export const diagramDictionary = {
  block: {
    add_source_text: "Add a Mermaid diagram",
    input_placeholder: "Enter diagram code",
    preview_error_text: "Invalid diagram (click to edit)",
    preview_label: "Mermaid diagram",
  },
  slash_menu: {
    diagram: {
      title: "Diagram",
      subtext: "Diagram rendered from Mermaid source",
      aliases: ["mermaid", "diagram", "flowchart", "chart", "graph"],
      group: "Advanced",
    },
  },
  block_type_select: { name: "Diagram" },
  exporter: {
    invalid_diagram: (source: string) => `Invalid diagram "${source}"`,
  },
};
const config = createBlockConfig(
  () =>
    ({
      type: "diagram" as const,
      propSchema: {},
      content: "plain" as const,
    }) as const,
)();
export const diagramBlockSpec = createReactBlockSpec(config, {
  meta: {
    code: true,
    defining: true,
    isolating: false,
    highlight: () => "mermaid",
    hasPreview: true,
    hardBreakShortcut: "enter",
  },
  parse: (element: HTMLElement) => {
    const code = element.firstElementChild;
    if (
      element.tagName !== "PRE" ||
      element.childElementCount !== 1 ||
      code?.tagName !== "CODE"
    )
      return undefined;
    const language =
      code.getAttribute("data-language") ||
      code.className
        .split(" ")
        .find((name) => name.startsWith("language-"))
        ?.replace("language-", "");
    return language === "mermaid" ? {} : undefined;
  },
  parseContent: (options) => parsePreCodeContent(options, "diagram"),
  runsBefore: ["codeBlock"],
  toExternalHTML: (props) => (
    <pre>
      <code
        className="language-mermaid"
        data-language="mermaid"
        ref={props.contentRef}
      />
    </pre>
  ),
  render: (props) => {
    const source = plainContentToString(props.block.content);
    return (
      <SourceBlockWithPreview
        {...props}
        source={source}
        preview={<ReaderDiagram source={source} />}
      />
    );
  },
})();
