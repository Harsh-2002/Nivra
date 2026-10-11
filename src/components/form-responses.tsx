"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowLeft, Check, Download, Search, Trash2 } from "lucide-react";
import { api, downloadRequest } from "@/lib/client";
import type { FormAnswers, FormDefinition, FormField } from "@/lib/forms";
import { displayField } from "@/lib/forms";
import { useCompletion } from "@/lib/completion-client";
import { ItemTagPicker } from "./item-tag-picker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { LoadingState } from "./loading-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useConfirm } from "./confirm-provider";

type ResponseRow = {
  id: string;
  versionId: string;
  reviewed: boolean;
  revision: number;
  createdAt: number;
  preview: string;
};
type ResponsePage = {
  items: ResponseRow[];
  total: number;
  next: string | null;
};
type ResponseDetail = Omit<ResponseRow, "preview"> & {
  formId: string;
  definition: FormDefinition;
  answers: FormAnswers;
  files: {
    id: string;
    fieldId: string;
    filename: string;
    mime: string;
    size: number;
    hasThumbnail: boolean;
    url: string;
  }[];
};
type SummaryField = Pick<
  FormField,
  "id" | "label" | "type" | "choices" | "currency"
> & {
  answered: number;
  distribution: Record<string, number>;
  sum?: number | string;
  average?: number | null;
  minimum?: number | null;
  maximum?: number | null;
  fileCount?: number;
};
type Summary = {
  total: number;
  newCount: number;
  versions: {
    id: string;
    title: string;
    createdAt: number;
    total: number;
    fields: SummaryField[];
  }[];
};
const dateTime = (value: number) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function answerLabel(
  field: FormField,
  answer: FormAnswers[string] | undefined,
) {
  if (
    answer === undefined ||
    answer === "" ||
    (Array.isArray(answer) && !answer.length)
  )
    return "No answer";
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (["single_choice", "multiple_choice", "dropdown"].includes(field.type))
    return (Array.isArray(answer) ? answer : [String(answer)])
      .map(
        (id) => field.choices.find((choice) => choice.id === id)?.label ?? id,
      )
      .join(", ");
  return `${answer}${field.type === "amount" ? ` ${field.currency}` : ""}`;
}
export function FormResponses({
  formId,
  responseId,
  date,
  timezone = "UTC",
  onOpen,
}: {
  formId: string;
  responseId?: string;
  date?: string;
  timezone?: string;
  onOpen: (id?: string) => void;
}) {
  const [tab, setTab] = useState<"summary" | "submissions">(
    date ? "submissions" : "summary",
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<ResponsePage | null>(null);
  const [detail, setDetail] = useState<ResponseDetail | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [reviewed, setReviewed] = useState("all");
  const [version, setVersion] = useState("all");
  const [summaryVersion, setSummaryVersion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ticket = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const operation = useRef<{
    key: string;
    identity: string;
    body: string;
  } | null>(null);
  const confirm = useConfirm();
  const parameters = useCallback(
    () =>
      new URLSearchParams({
        q: search,
        reviewed,
        ...(version === "all" ? {} : { versionId: version }),
        ...(date ? { date, timezone } : {}),
      }),
    [search, reviewed, version, date, timezone],
  );
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++ticket.current;
      try {
        const [results, rows, submission] = await Promise.all([
          api<Summary>(`forms/${formId}/summary`, { signal }),
          !responseId && tab === "submissions"
            ? api<ResponsePage>(`forms/${formId}/responses?${parameters()}`, {
                signal,
              })
            : Promise.resolve(null),
          responseId
            ? api<ResponseDetail>(`forms/${formId}/responses/${responseId}`, {
                signal,
              })
            : Promise.resolve(null),
        ]);
        if (signal?.aborted || sequence !== ticket.current) return;
        setSummary(results);
        setPage(rows);
        setDetail(submission);
        setError("");
      } catch (failure) {
        if (!signal?.aborted && sequence === ticket.current)
          setError(
            failure instanceof Error
              ? failure.message
              : "Responses could not load. Try again.",
          );
      }
    },
    [formId, responseId, tab, parameters],
  );
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPage(null);
      setDetail(null);
      void load(controller.signal);
    }, 0);
    return () => {
      clearTimeout(timer);
      clearTimeout(reloadTimer.current);
      controller.abort();
    };
  }, [load]);
  useCompletion("content", (event) => {
    if (event.target && event.target !== formId) return;
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void latestLoad.current(), 150);
  });
  useEffect(() => () => clearTimeout(reloadTimer.current), []);
  async function loadMore() {
    if (!page?.next) return;
    const sequence = ticket.current;
    setMore(true);
    try {
      const query = parameters();
      query.set("after", page.next);
      const result = await api<ResponsePage>(
        `forms/${formId}/responses?${query}`,
      );
      if (sequence === ticket.current)
        setPage((current) =>
          current
            ? {
                ...result,
                items: [
                  ...current.items,
                  ...result.items.filter(
                    (row) => !current.items.some((item) => item.id === row.id),
                  ),
                ],
              }
            : result,
        );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "More responses could not load.",
      );
    } finally {
      setMore(false);
    }
  }
  async function change(action: "review" | "trash") {
    if (!detail) return;
    if (
      action === "trash" &&
      !(await confirm({
        title: "Move submission to Trash?",
        description:
          "The answers and uploaded files stay together. You can restore this submission from Trash.",
        action: "Move to Trash",
      }))
    )
      return;
    const identity = `${detail.id}:${action}:${detail.revision}`;
    if (operation.current?.identity !== identity)
      operation.current = {
        identity,
        key: crypto.randomUUID(),
        body: JSON.stringify({
          revision: detail.revision,
          ...(action === "review" ? { reviewed: !detail.reviewed } : {}),
        }),
      };
    setBusy(true);
    setError("");
    try {
      await api(`forms/${formId}/responses/${detail.id}`, {
        method: action === "trash" ? "DELETE" : "PATCH",
        headers: { "Idempotency-Key": operation.current.key },
        body: operation.current.body,
      });
      operation.current = null;
      if (action === "trash") {
        setTab("submissions");
        onOpen();
      } else await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The submission could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function exportData(format: "csv" | "json") {
    setExporting(true);
    setError("");
    try {
      const query = parameters();
      await downloadRequest(
        `forms/${formId}/export/${format}?${query}`,
        `form-responses.${format}`,
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The export could not be downloaded.",
      );
    } finally {
      setExporting(false);
    }
  }
  const selected =
    summary?.versions.find((item) => item.id === summaryVersion) ??
    summary?.versions[0];
  return (
    <div className="form-results mx-auto w-full max-w-5xl pb-12">
      {error && (
        <div className="mb-5 flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
      {responseId ? (
        !detail ? (
          !error && <LoadingState kind="notes" label="Loading submission" />
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setTab("submissions");
                  onOpen();
                }}
              >
                <ArrowLeft />
                Submissions
              </Button>
              <div className="flex flex-wrap gap-2">
                <ItemTagPicker
                  type="response"
                  id={detail.id}
                  title="Submission"
                  disabled={busy}
                  compact={false}
                  onChanged={() => load()}
                />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void change("review")}
                >
                  <Check />
                  {detail.reviewed ? "Mark as new" : "Mark reviewed"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void change("trash")}
                >
                  <Trash2 />
                  Move to Trash
                </Button>
              </div>
            </div>
            <div className="mb-8 space-y-2">
              <h2 className="text-xl font-semibold">Submission</h2>
              <p className="text-sm text-muted-foreground">
                {dateTime(detail.createdAt)} ·{" "}
                {detail.reviewed ? "Reviewed" : "New"}
              </p>
              <p className="text-sm text-muted-foreground">
                Answers use the form published at the time of submission.
              </p>
            </div>
            <dl className="space-y-7">
              {detail.definition.fields
                .filter((field) => !displayField(field))
                .map((field) => (
                  <div key={field.id}>
                    <dt className="mb-2 font-medium">{field.label}</dt>
                    <dd className="whitespace-pre-wrap text-sm break-words">
                      {field.type === "file" ? (
                        <ul className="space-y-3">
                          {detail.files
                            .filter((file) => file.fieldId === field.id)
                            .map((file) => (
                              <li
                                key={file.id}
                                className="flex flex-wrap items-center gap-3"
                              >
                                {file.hasThumbnail && (
                                  <Image
                                    src={`${file.url}?thumbnail=1`}
                                    unoptimized
                                    width={120}
                                    height={90}
                                    alt={`Preview of ${file.filename}`}
                                    className="max-h-24 rounded-lg object-contain"
                                  />
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className="break-all">{file.filename}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {(file.size / 1024).toLocaleString(
                                      undefined,
                                      { maximumFractionDigits: 1 },
                                    )}{" "}
                                    KB
                                  </p>
                                </div>
                                <Button variant="outline" asChild>
                                  <a href={file.url} download>
                                    <Download />
                                    Download
                                  </a>
                                </Button>
                              </li>
                            ))}
                          {!detail.files.some(
                            (file) => file.fieldId === field.id,
                          ) && (
                            <li className="text-muted-foreground">No files</li>
                          )}
                        </ul>
                      ) : (
                        answerLabel(field, detail.answers[field.id])
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
          </>
        )
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2" role="group" aria-label="Response view">
              {(["summary", "submissions"] as const).map((value) => (
                <Button
                  key={value}
                  variant={tab === value ? "secondary" : "ghost"}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  {value === "summary" ? "Summary" : "Submissions"}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">
              {summary?.total.toLocaleString() ?? "…"}{" "}
              {summary?.total === 1 ? "response" : "responses"}
              {summary && summary.newCount > 0
                ? ` · ${summary.newCount.toLocaleString()} new`
                : ""}
            </p>
          </div>
          {!summary && !error ? (
            <LoadingState kind="notes" label="Loading response summary" />
          ) : summary?.total === 0 ? (
            <div className="py-12 text-center">
              <h2 className="mb-2 font-semibold">No submissions yet</h2>
              <p className="text-muted-foreground">
                Publish your form and share its link to collect responses.
              </p>
            </div>
          ) : tab === "summary" && selected ? (
            <>
              <div className="mb-8">
                <label
                  className="mb-2 block text-sm font-medium"
                  htmlFor="summary-version"
                >
                  Published version
                </label>
                <Select value={selected.id} onValueChange={setSummaryVersion}>
                  <SelectTrigger
                    id="summary-version"
                    className="w-full sm:w-auto sm:max-w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {summary!.versions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {dateTime(item.createdAt)} ·{" "}
                        {item.total.toLocaleString()}{" "}
                        {item.total === 1 ? "response" : "responses"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-8">
                {selected.fields.map((field) => (
                  <section key={field.id} className="space-y-3">
                    <div className="flex flex-wrap justify-between gap-2">
                      <h3 className="font-medium">{field.label}</h3>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {field.answered.toLocaleString()} answered
                      </span>
                    </div>
                    {Object.entries(field.distribution).map(([key, count]) => (
                      <div
                        key={key}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2"
                      >
                        <span className="text-sm break-words">
                          {field.choices.find((choice) => choice.id === key)
                            ?.label ??
                            (key === "true"
                              ? "Yes"
                              : key === "false"
                                ? "No"
                                : key)}
                        </span>
                        <span className="text-sm tabular-nums">
                          {count.toLocaleString()}
                        </span>
                        <progress
                          className="form-summary-bar col-span-2 w-full"
                          value={count}
                          max={Math.max(1, field.answered)}
                          aria-label={`${field.label}: ${field.choices.find((choice) => choice.id === key)?.label ?? (key === "true" ? "Yes" : key === "false" ? "No" : key)}`}
                        />
                      </div>
                    ))}
                    {Object.keys(field.distribution).length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {field.type === "amount"
                          ? `Total ${field.sum ?? "0.00"} ${field.currency}`
                          : field.fileCount !== undefined
                            ? `${field.fileCount.toLocaleString()} files`
                            : field.average !== undefined
                              ? field.average === null
                                ? "No answers"
                                : `Average ${field.average.toLocaleString(undefined, { maximumFractionDigits: 2 })} · Minimum ${field.minimum} · Maximum ${field.maximum}`
                              : "Read individual answers in Submissions."}
                      </p>
                    )}
                  </section>
                ))}
              </div>
            </>
          ) : tab === "submissions" ? (
            <>
              {date && (
                <p className="mb-5 text-sm text-muted-foreground">
                  Submissions on {date} · {timezone}
                </p>
              )}
              <div className="mb-5 flex flex-wrap gap-3">
                <Select value={reviewed} onValueChange={setReviewed}>
                  <SelectTrigger
                    className="w-auto min-w-36"
                    aria-label="Review status"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All submissions</SelectItem>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={version} onValueChange={setVersion}>
                  <SelectTrigger
                    className="w-auto max-w-full"
                    aria-label="Submission version"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All versions</SelectItem>
                    {summary?.versions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {dateTime(item.createdAt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative min-w-44 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="Search submissions"
                    placeholder="Search answers…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {page?.total.toLocaleString() ?? "…"} matching submissions
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={exporting}
                    onClick={() => void exportData("csv")}
                  >
                    <Download />
                    CSV
                  </Button>
                  <Button
                    variant="outline"
                    disabled={exporting}
                    onClick={() => void exportData("json")}
                  >
                    <Download />
                    JSON
                  </Button>
                </div>
              </div>
              {!page && !error ? (
                <LoadingState kind="notes" label="Loading submissions" />
              ) : page?.items.length === 0 ? (
                <p className="py-12 text-center text-muted-foreground">
                  No matching submissions. Try a different search or filter.
                </p>
              ) : (
                <ul className="space-y-2">
                  {page?.items.map((row) => (
                    <li key={row.id}>
                      <Button
                        variant="ghost"
                        className="h-auto w-full items-start justify-between gap-4 px-4 py-4 text-left"
                        onClick={() => onOpen(row.id)}
                      >
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {dateTime(row.createdAt)}
                          </span>
                          <span className="mt-1 block truncate font-normal text-muted-foreground">
                            {row.preview || "Submission"}
                          </span>
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {row.reviewed ? "Reviewed" : "New"}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {page?.next && (
                <Button
                  variant="outline"
                  className="mt-5"
                  disabled={more}
                  onClick={() => void loadMore()}
                >
                  {more ? "Loading…" : "Load more"}
                </Button>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
