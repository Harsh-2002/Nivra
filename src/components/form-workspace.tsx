"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, Eye, Monitor, Smartphone, Star } from "lucide-react";
import { api } from "@/lib/client";
import { publishableForm, type FormRecord } from "@/lib/forms";
import { formRoute, type FormRoute } from "@/lib/workspace-routes";
import { useFormDraft } from "@/lib/use-form-draft";
import { useCompletion } from "@/lib/completion-client";
import { FormBuilder } from "./form-builder";
import { FormRenderer } from "./form-renderer";
import { FormsPanel } from "./forms-panel";
import { FormResponses } from "./form-responses";
import { LoadingState } from "./loading-state";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { ItemTagPicker } from "./item-tag-picker";
import { DatePicker } from "./date-picker";
import { useConfirm } from "./confirm-provider";
import { NavigationIcon } from "./navigation-icon";

export function FormWorkspace({
  onNavigation,
  registerGuard,
}: {
  onNavigation: () => void;
  registerGuard: (guard: () => Promise<boolean>) => void;
}) {
  const [route, setRoute] = useState<FormRoute | null>(() =>
    typeof window === "undefined" ? null : formRoute(window.location.pathname),
  );
  const [form, setForm] = useState<FormRecord | null>(null);
  const [error, setError] = useState("");
  const localGuard = useRef<() => Promise<boolean>>(async () => true);
  const register = useCallback(
    (guard: () => Promise<boolean>) => {
      localGuard.current = guard;
      registerGuard(guard);
    },
    [registerGuard],
  );
  useEffect(() => {
    const changed = () => {
      setRoute(formRoute(window.location.pathname));
    };
    window.addEventListener("nivra:forms-route", changed);
    return () => {
      window.removeEventListener("nivra:forms-route", changed);
      registerGuard(async () => true);
    };
  }, [registerGuard]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!route) return;
      try {
        const result = await api<FormRecord>(`forms/${route.id}`, { signal });
        if (!signal?.aborted) {
          setForm(result);
          setError("");
        }
      } catch (failure) {
        if (!signal?.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "This form could not load.",
          );
      }
    },
    [route],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError("");
      setForm((current) =>
        !route || current?.id !== route.id ? null : current,
      );
      void load(controller.signal);
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, route]);
  async function navigate(next: FormRoute | null) {
    if (!(await localGuard.current())) return;
    const path = next
      ? `/forms/${next.id}/${next.tab}${next.responseId ? `/${next.responseId}` : ""}`
      : "/forms";
    const query =
      next?.tab === "responses" && route?.tab === "responses"
        ? window.location.search
        : "";
    window.history.pushState(null, "", path + query);
    window.dispatchEvent(new Event("nivra:route-updated"));
    setRoute(next);
    if (!next) {
      localGuard.current = async () => true;
      registerGuard(localGuard.current);
    }
  }
  if (!route)
    return (
      <FormsPanel
        onNavigation={onNavigation}
        onOpen={(id) => void navigate({ id, tab: "build" })}
      />
    );
  if (!form || form.id !== route.id)
    return (
      <section className="tasks-panel">
        <div className="tasks-scroll">
          <div className="section-content">
            <Button variant="ghost" onClick={() => void navigate(null)}>
              <ArrowLeft />
              Forms
            </Button>
            {error ? (
              <div className="mt-8 space-y-4">
                <p role="alert">{error}</p>
                <Button variant="outline" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : (
              <LoadingState kind="notes" label="Loading form" />
            )}
          </div>
        </div>
      </section>
    );
  return (
    <FormEditor
      key={form.id}
      initial={form}
      route={route}
      onSaved={setForm}
      onReload={load}
      onNavigate={(next) => void navigate(next)}
      registerGuard={register}
      onNavigation={onNavigation}
    />
  );
}
function FormEditor({
  initial,
  route,
  onSaved,
  onReload,
  onNavigate,
  registerGuard,
  onNavigation,
}: {
  initial: FormRecord;
  route: FormRoute;
  onSaved: (form: FormRecord) => void;
  onReload: () => Promise<void>;
  onNavigate: (route: FormRoute | null) => void;
  registerGuard: (guard: () => Promise<boolean>) => void;
  onNavigation: () => void;
}) {
  const draft = useFormDraft(initial, onSaved);
  const { form, state, error, flush, accept, reset } = draft;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const [phone, setPhone] = useState(false);
  const confirm = useConfirm();
  const [now, setNow] = useState(() => Date.now());
  const expired = form.closesAt !== null && form.closesAt <= now;
  useEffect(() => {
    if (!form.closesAt || form.closesAt <= now) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(form.closesAt - now + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [form.closesAt, now]);
  const operation = useRef<{
    action: string;
    revision: number;
    key: string;
  } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const completionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    registerGuard(flush);
  }, [registerGuard, flush]);
  useEffect(() => {
    accept(initial);
  }, [initial, accept]);
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
      clearTimeout(completionTimer.current);
    },
    [],
  );
  useCompletion("content", (event) => {
    if (event.target && event.target !== form.id) return;
    clearTimeout(completionTimer.current);
    completionTimer.current = setTimeout(() => {
      void api<FormRecord>(`forms/${form.id}`)
        .then((next) => {
          if (accept(next)) onSaved(next);
        })
        .catch((failure: unknown) =>
          setActionError(
            failure instanceof Error
              ? failure.message
              : "This form could not refresh.",
          ),
        );
    }, 180);
  });
  async function discard() {
    if (
      !(await confirm({
        title: "Reload form?",
        description:
          "Your unsaved draft will be replaced with the latest saved form. Existing submissions remain unchanged.",
        action: "Reload form",
      }))
    )
      return;
    try {
      const next = await api<FormRecord>(`forms/${form.id}`);
      reset(next);
      onSaved(next);
      setActionError("");
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "This form could not reload.",
      );
    }
  }
  async function lifecycle(
    action: "publish" | "close" | "reopen" | "unpublish",
  ) {
    if (
      action === "unpublish" &&
      !(await confirm({
        title: "Unpublish form?",
        description:
          "The current link will stop working. Submissions and files remain available. Publishing again creates a new link.",
        action: "Unpublish",
      }))
    )
      return;
    if (!(await flush())) return;
    const current = draft.current.current;
    if (
      operation.current?.action !== action ||
      operation.current.revision !== current.revision
    )
      operation.current = {
        action,
        revision: current.revision,
        key: crypto.randomUUID(),
      };
    setBusy(true);
    setActionError("");
    try {
      const next = await api<FormRecord>(`forms/${form.id}/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": operation.current.key },
        body: JSON.stringify({ revision: operation.current.revision }),
      });
      operation.current = null;
      accept(next);
      onSaved(next);
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "The publication could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(form.url!);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError("Copy failed. Select the link below and copy it.");
    }
  }
  const status =
    form.status === "draft"
      ? "Draft"
      : form.status === "closed"
        ? "Closed"
        : "Published";
  return (
    <section className="tasks-panel form-workspace">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Form workspace"
      >
        <div className="section-content">
          <div className="mb-5 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => onNavigate(null)}>
              <ArrowLeft />
              Forms
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="menu-toggle"
              aria-label="Open navigation"
              onClick={onNavigation}
            >
              <NavigationIcon />
            </Button>
          </div>
          <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 basis-full md:basis-0 md:flex-1">
              <h1 className="text-2xl font-semibold break-words">
                {form.title || "Untitled form"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {expired && form.status === "published"
                  ? "Closed · Closing date reached"
                  : status}
                {form.hasUnpublishedChanges && form.status !== "draft"
                  ? " · Unpublished changes"
                  : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="mr-1 text-xs text-muted-foreground"
                role="status"
              >
                {state === "saved"
                  ? "Saved"
                  : state === "saving"
                    ? "Saving…"
                    : state === "conflict"
                      ? "Save conflict"
                      : "Unsaved"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  form.favorite
                    ? "Remove form from Favorites"
                    : "Add form to Favorites"
                }
                aria-pressed={form.favorite}
                disabled={busy}
                onClick={() =>
                  draft.change((value) => ({
                    ...value,
                    favorite: !value.favorite,
                  }))
                }
              >
                <Star fill={form.favorite ? "currentColor" : "none"} />
              </Button>
              <ItemTagPicker
                type="form"
                id={form.id}
                title={form.title || "Untitled form"}
                disabled={state !== "saved" || busy}
                onChanged={onReload}
              />
              <Button variant="outline" onClick={() => setPreview(true)}>
                <Eye />
                Preview
              </Button>
            </div>
          </header>
          {(error || actionError) && (
            <div
              className="mb-6 flex flex-wrap items-center gap-3"
              role="alert"
            >
              <p className="text-sm text-destructive">{error || actionError}</p>
              {state !== "conflict" && error && (
                <Button variant="outline" onClick={() => void flush()}>
                  Retry save
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={state === "saving" || busy}
                onClick={() => void discard()}
              >
                Reload form
              </Button>
            </div>
          )}
          <nav aria-label="Form sections" className="mb-8 flex flex-wrap gap-2">
            {(["build", "responses", "share"] as const).map((tab) => (
              <Button
                key={tab}
                variant={route.tab === tab ? "secondary" : "ghost"}
                aria-current={route.tab === tab ? "page" : undefined}
                disabled={busy}
                onClick={() => onNavigate({ id: form.id, tab })}
              >
                {tab === "build"
                  ? "Build"
                  : tab === "responses"
                    ? "Responses"
                    : "Share"}
              </Button>
            ))}
          </nav>
          {route.tab === "build" ? (
            <fieldset disabled={busy} className="min-w-0">
              <FormBuilder
                definition={form.definition}
                onChange={(definition) =>
                  draft.change((value) => ({ ...value, definition }))
                }
              />
            </fieldset>
          ) : route.tab === "responses" ? (
            <FormResponses
              key={`${form.id}:${typeof window === "undefined" ? "" : window.location.search}`}
              formId={form.id}
              responseId={route.responseId}
              date={
                typeof window === "undefined"
                  ? undefined
                  : (new URLSearchParams(window.location.search).get("date") ??
                    undefined)
              }
              timezone={
                typeof window === "undefined"
                  ? "UTC"
                  : (new URLSearchParams(window.location.search).get(
                      "timezone",
                    ) ?? "UTC")
              }
              onOpen={(responseId) =>
                onNavigate({ id: form.id, tab: "responses", responseId })
              }
            />
          ) : (
            <div className="mx-auto w-full max-w-2xl space-y-8 pb-12">
              <section className="space-y-4">
                <h2 className="text-xl font-semibold">Share your form</h2>
                <p className="text-sm text-muted-foreground">
                  {form.status === "draft"
                    ? "Publish when your questions are ready. Anyone with the link can submit a response."
                    : form.status === "closed"
                      ? "Your form is closed. The link shows a closed message and new submissions are disabled."
                      : "Your published form is accepting responses. Draft changes go live when you publish them."}
                </p>
                {form.url && (
                  <div className="space-y-3">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium">Public link</span>
                      <Input
                        readOnly
                        value={form.url}
                        onFocus={(event) => event.target.select()}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void copyLink()}>
                        <Copy />
                        {copied ? "Copied" : "Copy link"}
                      </Button>
                      <Button variant="ghost" asChild>
                        <a
                          href={form.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open form
                        </a>
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  {(form.status === "draft" || form.hasUnpublishedChanges) && (
                    <Button
                      disabled={busy || !publishableForm(form.definition)}
                      onClick={() => void lifecycle("publish")}
                    >
                      {busy
                        ? "Saving…"
                        : form.status === "draft"
                          ? "Publish"
                          : "Publish changes"}
                    </Button>
                  )}
                  {form.status === "published" && !expired && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void lifecycle("close")}
                    >
                      Close form
                    </Button>
                  )}
                  {form.status === "closed" && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void lifecycle("reopen")}
                    >
                      Reopen form
                    </Button>
                  )}
                  {expired && form.status !== "draft" && (
                    <p className="self-center text-sm text-muted-foreground">
                      Choose a future closing date or remove it to accept new
                      submissions.
                    </p>
                  )}
                  {form.status !== "draft" && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void lifecycle("unpublish")}
                    >
                      Unpublish
                    </Button>
                  )}
                </div>
                {!publishableForm(form.definition) && (
                  <p className="text-sm text-muted-foreground">
                    Add a title and at least one question. Name every question
                    and its options before publishing.
                  </p>
                )}
              </section>
              <section className="space-y-3">
                <h2 className="font-semibold">Accept submissions until</h2>
                <DatePicker
                  label="Closing date"
                  value={form.deadline?.date ?? null}
                  disabled={busy}
                  onChange={(date) =>
                    draft.change((value) => ({
                      ...value,
                      deadline: date
                        ? {
                            date,
                            timezone:
                              value.deadline?.timezone ??
                              Intl.DateTimeFormat().resolvedOptions().timeZone,
                          }
                        : null,
                    }))
                  }
                />
                <p className="text-sm text-muted-foreground">
                  {form.deadline
                    ? `Accepts responses through the end of this day in ${form.deadline.timezone}. The closing date appears in Calendar.`
                    : "No closing date. You can close the form manually at any time."}
                </p>
              </section>
              <section className="space-y-3">
                <h2 className="font-semibold">File storage</h2>
                <p className="text-sm text-muted-foreground">
                  This budget includes submitted files and temporary uploads.
                  Files stay private to you.
                </p>
                <label className="grid gap-2">
                  <span className="text-sm">Upload budget (MB)</span>
                  <Input
                    type="number"
                    min={0}
                    max={10240}
                    value={Math.round(form.uploadBudget / 1024 / 1024)}
                    disabled={busy}
                    onChange={(event) =>
                      draft.change((value) => ({
                        ...value,
                        uploadBudget: Number(event.target.value) * 1024 * 1024,
                      }))
                    }
                  />
                </label>
                <p className="text-sm text-muted-foreground">
                  Set to 0 to disable new file uploads. Existing files remain
                  available.
                </p>
              </section>
            </div>
          )}
          <Dialog open={preview} onOpenChange={setPreview}>
            <DialogContent
              showCloseButton={false}
              className="form-preview-dialog flex h-[min(88dvh,900px)] w-[min(960px,calc(100vw-48px))] max-w-none flex-col gap-0 p-0 sm:max-w-none"
            >
              <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                <div>
                  <DialogTitle>Preview</DialogTitle>
                  <DialogDescription className="mt-1">
                    Preview answers are not saved.
                  </DialogDescription>
                </div>
                <div className="flex items-center gap-2">
                  <div className="hidden gap-1 md:flex">
                    <Button
                      variant={phone ? "ghost" : "secondary"}
                      size="icon"
                      aria-label="Desktop preview"
                      aria-pressed={!phone}
                      onClick={() => setPhone(false)}
                    >
                      <Monitor />
                    </Button>
                    <Button
                      variant={phone ? "secondary" : "ghost"}
                      size="icon"
                      aria-label="Mobile preview"
                      aria-pressed={phone}
                      onClick={() => setPhone(true)}
                    >
                      <Smartphone />
                    </Button>
                  </div>
                  <Button variant="ghost" onClick={() => setPreview(false)}>
                    Back to form
                  </Button>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-7">
                <div
                  className={`mx-auto w-full ${phone ? "max-w-[390px]" : "max-w-2xl"}`}
                >
                  <FormRenderer
                    key={JSON.stringify(form.definition)}
                    definition={form.definition}
                    preview
                  />
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </section>
  );
}
