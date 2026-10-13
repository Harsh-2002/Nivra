export type Document = { schemaVersion: 1; blocks: Record<string, unknown>[] };
export type Board = {
  id: string;
  name: string;
  archivedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type BoardDetail = Board & {
  counts: Record<import("./boards").TaskStage, number>;
  url?: string;
};
export type Task = {
  boardId: string | null;
  boardPosition: number;
  status: import("./boards").TaskStage;
  boardName?: string | null;
  tags?: Tag[];
  id: string;
  title: string;
  completedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  dueDate: string | null;
  plannedDate: string | null;
  recurrence: import("./dates").Recurrence | null;
  recurrenceDay: number | null;
  recurrenceRule: import("./task-planning").TaskRecurrenceRule | null;
  schedule: import("./task-planning").TaskSchedule | null;
  scheduleIssue: import("./task-planning").TaskScheduleIssue;
  steps?: import("./task-planning").TaskStep[];
  stepProgress: { completed: number; total: number };
  parentTaskId: string | null;
  noteId: string | null;
  noteTitle: string | null;
};
export type TaskStep = import("./task-planning").TaskStep;
export type Note = {
  id: string;
  title: string;
  document: Document;
  text: string;
  revision: number;
  favorite: boolean;
  editorWidth: "standard" | "wide";
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  tags: Tag[];
  kind: "note";
  dailyDate: string | null;
  journalPeriod: JournalPeriod | null;
  journalPeriodStart: string | null;
};
export type NoteSummary = Omit<Note, "document">;
export type TaggedItem = {
  formId?: string;
  id: string;
  type:
    | "note"
    | "journal"
    | "task"
    | "bookmark"
    | "artifact"
    | "event"
    | "form"
    | "response";
  title: string;
  excerpt: string;
  updatedAt: number;
  dailyDate: string | null;
  journalPeriod?: JournalPeriod | null;
  journalPeriodStart?: string | null;
  favorite: boolean;
  completed: boolean;
  tags: Tag[];
};
export type Tag = {
  aliases?: string[];
  id: string;
  name: string;
  color: import("./tags").TagColor;
};
export type Settings = {
  theme: "light" | "dark" | "system";
  onboardingStep: "tags" | "install" | "complete";
  uploadLimit: number;
  twoFactorEnabled?: boolean;
  hasPassword?: boolean;
};
export type Publication = {
  token: string;
  revision: number;
  publishedAt: number;
};
export type Owner = { id: string; name: string; username: string };
export const emptyDocument: Document = {
  schemaVersion: 1,
  blocks: [{ type: "paragraph", content: [] }],
};
export type Bookmark = {
  id: string;
  url: string;
  title: string;
  description: string;
  siteName: string;
  collection: string;
  favorite: boolean;
  readAt: number | null;
  articleStatus: "pending" | "ready" | "unavailable";
  articleGeneration: number;
  articleVersion: number;
  metadataStatus: "pending" | "ready" | "unavailable";
  thumbnail: string | null;
  icon: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  noteId: string | null;
  noteTitle: string | null;
};

export type JournalPeriod = "daily" | "weekly" | "monthly";

export type WritingTemplate = {
  id: string;
  name: string;
  description: string;
  kind: "note" | "journal";
  document: Document;
  revision: number;
  createdAt: number;
  updatedAt: number;
  attachments?: { id: string; name: string; mime: string; size: number }[];
};

export type BookmarkArticle = import("./bookmark-reading").BookmarkArticle;
export type BookmarkHighlight = import("./bookmark-reading").BookmarkHighlight;
export type SearchResult = {
  formId?: string;
  dailyDate?: string | null;
  journalPeriod?: JournalPeriod | null;
  journalPeriodStart?: string | null;
  id: string;
  type:
    | "note"
    | "journal"
    | "task"
    | "bookmark"
    | "artifact"
    | "event"
    | "form"
    | "response";
  title: string;
  excerpt: string;
  artifactKind?: "text" | "image" | "file";
  updatedAt: number;
  completed?: boolean;
  titleMatches?: import("./search-context").TextRange[];
  excerptMatches?: import("./search-context").TextRange[];
  matchTerms?: string[];
};
export type NoteVersion = {
  id: string;
  title: string;
  revision: number;
  createdAt: number;
  document?: Document;
};
export type Connections = {
  incoming: { id: string; title: string }[];
  outgoing: { id: string; title: string }[];
  tasks: { id: string; title: string; completed: boolean }[];
  bookmarks: { id: string; title: string; url: string }[];
};

export type OverviewRecentItem =
  | {
      id: string;
      type: "note";
      title: string;
      updatedAt: number;
    }
  | {
      id: string;
      type: "journal";
      title: string;
      date: string;
      updatedAt: number;
    }
  | {
      id: string;
      type: "bookmark";
      title: string;
      url: string;
      siteName: string;
      updatedAt: number;
    }
  | {
      id: string;
      type: "artifact";
      title: string;
      updatedAt: number;
    };
export type OverviewRecentContent = Exclude<
  OverviewRecentItem,
  { type: "bookmark" }
>;

export type Overview = {
  counts: { open: number; today: number; overdue: number };
  tasks: Pick<Task, "id" | "title" | "revision" | "dueDate" | "recurrence">[];
  notes: Pick<Note, "id" | "title" | "updatedAt">[];
  bookmarks: Pick<
    Bookmark,
    "id" | "title" | "url" | "description" | "siteName" | "updatedAt"
  >[];
  calendar: {
    id: string;
    sourceId: string;
    type: "event";
    title: string;
    date: string;
    startAt?: number;
    endAt?: number;
    label: string;
    revision: number;
    occurrence?: string;
  }[];
  recentItems: OverviewRecentItem[];
  recentContent: OverviewRecentContent[];
  recentResponses?: {
    id: string;
    formId: string;
    formTitle: string;
    createdAt: number;
    reviewed: boolean;
  }[];
  review?: { formResponses: number; tagSuggestions: number };
  refreshedAt: number;
};
export type Page<T> = { items: T[]; next: string | null };
export type TaskFilter = "open" | "completed";
export type Artifact = {
  id: string;
  kind: "text" | "image" | "file";
  title: string;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  preview: string;
  thumbnail: boolean;
  extraction: "none" | "pending" | "done" | "failed";
  revision: number;
  createdAt: number;
  updatedAt: number;
  excerpt?: string;
  excerptMatches?: import("./search-context").TextRange[];
};
export type ArtifactDetail = Artifact & { content: string };

export type TrashKind =
  | "note"
  | "journal"
  | "task"
  | "bookmark"
  | "artifact"
  | "event"
  | "form"
  | "form_response";
export type TrashItem = {
  id: string;
  kind: TrashKind;
  title: string;
  excerpt: string;
  revision: number;
  trashedAt: number;
};
