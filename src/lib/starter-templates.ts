import type { Document, WritingTemplate } from "./types";

export type StarterTemplate = Pick<
  WritingTemplate,
  "name" | "description" | "kind" | "document"
>;

type Block = Record<string, unknown>;

const text = (value: string) => [{ type: "text", text: value, styles: {} }];
const heading = (value: string): Block => ({
  type: "heading",
  props: { level: 2 },
  content: text(value),
});
const paragraph = (value = ""): Block => ({
  type: "paragraph",
  content: value ? text(value) : [],
});
const bullet = (value = ""): Block => ({
  type: "bulletListItem",
  content: value ? text(value) : [],
});
const todo = (value = ""): Block => ({
  type: "checkListItem",
  props: { checked: false },
  content: value ? text(value) : [],
});
const document = (...blocks: Block[]): Document => ({
  schemaVersion: 1,
  blocks,
});

export const starterTemplates: readonly StarterTemplate[] = [
  {
    name: "Meeting notes",
    kind: "note",
    description: "Agenda, discussion, decisions and follow-up actions.",
    document: document(
      paragraph("{{date}} · {{time}}"),
      heading("Attendees"),
      bullet(),
      heading("Agenda"),
      bullet(),
      heading("Notes"),
      paragraph(),
      heading("Decisions"),
      bullet(),
      heading("Action items"),
      todo(),
    ),
  },
  {
    name: "Project brief",
    kind: "note",
    description: "Goal, scope, milestones and risks for a new piece of work.",
    document: document(
      heading("Goal"),
      paragraph(),
      heading("Background"),
      paragraph(),
      heading("Scope"),
      bullet("In scope"),
      bullet("Out of scope"),
      heading("Milestones"),
      todo(),
      heading("Risks and open questions"),
      bullet(),
    ),
  },
  {
    name: "Decision record",
    kind: "note",
    description: "Capture context, options and the reasoning behind a choice.",
    document: document(
      paragraph("Decided on {{date}}"),
      heading("Context"),
      paragraph(),
      heading("Options considered"),
      bullet(),
      heading("Decision"),
      paragraph(),
      heading("Consequences"),
      bullet(),
    ),
  },
  {
    name: "Reading notes",
    kind: "note",
    description: "Key ideas, quotes and follow-ups from a book or article.",
    document: document(
      paragraph("Source: "),
      paragraph("Read on {{date}}"),
      heading("Key ideas"),
      bullet(),
      heading("Quotes"),
      paragraph(),
      heading("My thoughts"),
      paragraph(),
      heading("To follow up"),
      todo(),
    ),
  },
  {
    name: "Daily journal",
    kind: "journal",
    description: "Priorities, highlights and what to carry into tomorrow.",
    document: document(
      heading("Top priorities"),
      todo(),
      todo(),
      todo(),
      heading("Notes"),
      paragraph(),
      heading("Highlights"),
      bullet(),
      heading("Tomorrow"),
      todo(),
    ),
  },
  {
    name: "Weekly review",
    kind: "journal",
    description: "Look back at the week and set one clear focus for the next.",
    document: document(
      heading("Wins"),
      bullet(),
      heading("What didn’t go well"),
      bullet(),
      heading("Lessons"),
      paragraph(),
      heading("Next week’s focus"),
      todo(),
      todo(),
    ),
  },
];
