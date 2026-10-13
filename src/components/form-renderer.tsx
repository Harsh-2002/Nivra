"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { Check, FileUp, LoaderCircle, X } from "lucide-react";
import { api } from "@/lib/client";
import {
  displayField,
  validateFormAnswers,
  renderFormConfirmation,
  type FormAnswers,
  type FormDefinition,
  type FormField,
} from "@/lib/forms";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type UploadedFile = { id: string; filename: string; size: number };
const fileAccept = {
  image: "image/*",
  document: ".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx",
  audio: "audio/*",
  video: "video/*",
};
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const subscribeHydration = () => () => {};

export function FormRenderer({
  definition,
  token,
  versionId,
  preview = false,
  closed = false,
  maxFileBytes = 10 * 1024 * 1024,
  maxResponseBytes = 25 * 1024 * 1024,
}: {
  definition: FormDefinition;
  token?: string;
  versionId?: string;
  preview?: boolean;
  closed?: boolean;
  maxFileBytes?: number;
  maxResponseBytes?: number;
}) {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false,
  );
  const resolver: Resolver<FormAnswers> = async (values) => {
    const result = validateFormAnswers(definition, values);
    if (!Object.keys(result.errors).length)
      return { values: result.answers, errors: {} };
    return {
      values: {},
      errors: Object.fromEntries(
        Object.entries(result.errors).map(([id, message]) => [
          id,
          { type: "validate", message },
        ]),
      ),
    };
  };
  const {
    control,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormAnswers>({
    resolver,
    defaultValues: {},
    shouldFocusError: false,
  });
  const [files, setFiles] = useState<Record<string, UploadedFile[]>>({});
  const [uploading, setUploading] = useState(false);
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const session = useRef<{ secret: string; expiresAt: number } | null>(null);
  const retry = useRef<{ answers: string; key: string } | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const disabled = !hydrated || isSubmitting || uploading;

  async function upload(field: FormField, selected: File[]) {
    if (preview || !token || !versionId) return;
    setFileErrors((current) => ({ ...current, [field.id]: "" }));
    const existing = files[field.id] ?? [];
    if (selected.length + existing.length > field.maxFiles) {
      setFileErrors((current) => ({
        ...current,
        [field.id]: `Choose up to ${field.maxFiles} files.`,
      }));
      return;
    }
    if (selected.some((file) => !file.size || file.size > maxFileBytes)) {
      setFileErrors((current) => ({
        ...current,
        [field.id]: `Each file must be nonempty and no larger than ${megabytes(maxFileBytes)}.`,
      }));
      return;
    }
    const total =
      Object.values(files)
        .flat()
        .reduce((sum, file) => sum + file.size, 0) +
      selected.reduce((sum, file) => sum + file.size, 0);
    if (total > maxResponseBytes) {
      setFileErrors((current) => ({
        ...current,
        [field.id]: `Keep all files within ${megabytes(maxResponseBytes)}.`,
      }));
      return;
    }
    setUploading(true);
    const attached = [...existing];
    try {
      if (!session.current || session.current.expiresAt <= Date.now())
        session.current = await api(`public/forms/${token}/sessions`, {
          method: "POST",
          body: JSON.stringify({ versionId }),
        });
      const secret = session.current!.secret;
      for (const file of selected) {
        const reservation = await api<{ id: string }>(
          `public/forms/${token}/uploads`,
          {
            method: "POST",
            body: JSON.stringify({
              secret,
              fieldId: field.id,
              filename: file.name,
              size: file.size,
            }),
          },
        );
        try {
          const ready = await api<UploadedFile>(
            `public/forms/${token}/uploads/${reservation.id}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "X-Form-Upload": secret,
              },
              body: file,
            },
          );
          attached.push(ready);
          setFiles((current) => ({ ...current, [field.id]: [...attached] }));
          setValue(
            field.id,
            attached.map((item) => item.id),
            { shouldValidate: true },
          );
        } catch (failure) {
          await api(`public/forms/${token}/uploads/${reservation.id}`, {
            method: "DELETE",
            body: JSON.stringify({ secret }),
          }).catch(() => undefined);
          throw failure;
        }
      }
    } catch (failure) {
      setFileErrors((current) => ({
        ...current,
        [field.id]:
          failure instanceof Error
            ? failure.message
            : "This file could not be uploaded. Try again.",
      }));
    } finally {
      setUploading(false);
    }
  }
  async function removeFile(fieldId: string, id: string) {
    if (!token || !session.current) return;
    setUploading(true);
    try {
      await api(`public/forms/${token}/uploads/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ secret: session.current.secret }),
      });
      const remaining = (files[fieldId] ?? []).filter((file) => file.id !== id);
      setFiles((current) => ({ ...current, [fieldId]: remaining }));
      setValue(
        fieldId,
        remaining.map((file) => file.id),
        { shouldValidate: true },
      );
    } catch (failure) {
      setFileErrors((current) => ({
        ...current,
        [fieldId]:
          failure instanceof Error
            ? failure.message
            : "This file could not be removed. Try again.",
      }));
    } finally {
      setUploading(false);
    }
  }
  async function submit(answers: FormAnswers) {
    setError("");
    if (preview) {
      setConfirmation(renderFormConfirmation(definition, answers));
      return;
    }
    if (!token || !versionId) return;
    const fingerprint = JSON.stringify(
      Object.fromEntries(
        Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    if (!retry.current || retry.current.answers !== fingerprint)
      retry.current = { answers: fingerprint, key: crypto.randomUUID() };
    try {
      const accepted = await api<{ confirmation: string }>(
        `public/forms/${token}/responses`,
        {
          method: "POST",
          body: JSON.stringify({
            versionId,
            retryKey: retry.current.key,
            answers,
            ...(session.current
              ? { uploadSecret: session.current.secret }
              : {}),
          }),
        },
      );
      setConfirmation(accepted.confirmation);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Your response could not be submitted. Your answers are still here. Try again.",
      );
      requestAnimationFrame(() => feedback.current?.focus());
    }
  }
  function focusError() {
    const { errors: issues } = validateFormAnswers(definition, getValues());
    const first = definition.fields.find((field) => issues[field.id]);
    if (first)
      requestAnimationFrame(() => {
        const container = document.getElementById(`form-field-${first.id}`);
        container?.querySelector<HTMLElement>("input,textarea,button")?.focus();
        container?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
  }
  if (confirmation)
    return (
      <div className="space-y-4 py-8" role="status">
        <Check className="size-6" aria-hidden="true" />
        <h2 className="text-xl font-semibold">
          {preview ? "Preview complete" : "Response submitted"}
        </h2>
        <p className="whitespace-pre-wrap text-muted-foreground">
          {confirmation}
        </p>
        {preview && (
          <Button variant="outline" onClick={() => setConfirmation("")}>
            Try preview again
          </Button>
        )}
      </div>
    );
  return (
    <div className="form-renderer mx-auto w-full max-w-2xl">
      <div className="mb-8 space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight break-words">
          {definition.title || "Untitled form"}
        </h1>
        {definition.description && (
          <p className="whitespace-pre-wrap text-muted-foreground break-words">
            {definition.description}
          </p>
        )}
      </div>
      {closed ? (
        <p className="rounded-xl border p-5 text-muted-foreground">
          This form is closed to submissions.
        </p>
      ) : (
        <form
          noValidate
          aria-busy={!hydrated}
          className="space-y-7"
          onSubmit={handleSubmit(submit, focusError)}
        >
          <fieldset disabled={disabled} className="min-w-0 space-y-7">
            {definition.fields.map((question) =>
              displayField(question) ? (
                <div key={question.id} className="space-y-2 pt-3">
                  {question.type === "description" ? (
                    <p className="whitespace-pre-wrap break-words">
                      {question.label}
                    </p>
                  ) : (
                    <h2 className="text-lg font-semibold break-words">
                      {question.label}
                    </h2>
                  )}
                  {question.description && (
                    <p className="whitespace-pre-wrap text-muted-foreground break-words">
                      {question.description}
                    </p>
                  )}
                </div>
              ) : (
                <div
                  key={question.id}
                  id={`form-field-${question.id}`}
                  className="space-y-2"
                >
                  <label
                    id={`label-${question.id}`}
                    htmlFor={
                      [
                        "single_choice",
                        "multiple_choice",
                        "yes_no",
                        "rating",
                        "file",
                      ].includes(question.type)
                        ? undefined
                        : `input-${question.id}`
                    }
                    className="block font-medium break-words"
                  >
                    {question.label || "Untitled question"}
                    {question.required && (
                      <>
                        <span
                          className="ml-1 text-muted-foreground"
                          aria-hidden="true"
                        >
                          *
                        </span>
                        {[
                          "file",
                          "multiple_choice",
                          "single_choice",
                          "yes_no",
                          "rating",
                        ].includes(question.type) && (
                          <span className="sr-only">, required</span>
                        )}
                      </>
                    )}
                  </label>
                  {question.description && (
                    <p
                      id={`hint-${question.id}`}
                      className="whitespace-pre-wrap text-sm text-muted-foreground break-words"
                    >
                      {question.description}
                    </p>
                  )}
                  <Controller
                    name={question.id}
                    control={control}
                    defaultValue={
                      question.type === "multiple_choice" ||
                      question.type === "file"
                        ? []
                        : question.type === "consent"
                          ? false
                          : ""
                    }
                    render={({ field }) => {
                      const shared = {
                        id: `input-${question.id}`,
                        "aria-labelledby": `label-${question.id}`,
                        "aria-describedby":
                          [
                            question.description && `hint-${question.id}`,
                            errors[question.id]?.message &&
                              `error-${question.id}`,
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined,
                        "aria-invalid": !!errors[question.id],
                        ...([
                          "file",
                          "multiple_choice",
                          "single_choice",
                          "yes_no",
                          "rating",
                        ].includes(question.type)
                          ? {}
                          : { "aria-required": question.required }),
                        disabled,
                        onBlur: field.onBlur,
                      };
                      if (question.type === "long_text")
                        return (
                          <Textarea
                            {...shared}
                            ref={field.ref}
                            className="min-h-32"
                            maxLength={question.maxLength}
                            value={String(field.value ?? "")}
                            onChange={field.onChange}
                          />
                        );
                      if (question.type === "dropdown")
                        return (
                          <Select
                            value={String(field.value || "")}
                            onValueChange={field.onChange}
                            disabled={disabled}
                          >
                            <SelectTrigger
                              {...shared}
                              ref={field.ref}
                              className="w-full"
                            >
                              <SelectValue placeholder="Choose an option" />
                            </SelectTrigger>
                            <SelectContent>
                              {question.choices.map((choice) => (
                                <SelectItem key={choice.id} value={choice.id}>
                                  {choice.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      if (
                        question.type === "multiple_choice" ||
                        question.type === "consent"
                      ) {
                        const choices =
                          question.type === "consent"
                            ? [{ id: question.id, label: "I agree" }]
                            : question.choices;
                        return (
                          <div
                            className="space-y-1"
                            role="group"
                            aria-labelledby={`label-${question.id}`}
                          >
                            {choices.map((choice, index) => (
                              <label
                                key={choice.id}
                                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted"
                              >
                                <Checkbox
                                  {...(index === 0 ? shared : { disabled })}
                                  aria-describedby={shared["aria-describedby"]}
                                  aria-invalid={!!errors[question.id]}
                                  aria-labelledby={
                                    question.type === "consent"
                                      ? shared["aria-labelledby"]
                                      : undefined
                                  }
                                  id={
                                    index === 0
                                      ? shared.id
                                      : `${shared.id}-${choice.id}`
                                  }
                                  ref={index === 0 ? field.ref : undefined}
                                  checked={
                                    question.type === "consent"
                                      ? field.value === true
                                      : Array.isArray(field.value) &&
                                        field.value.includes(choice.id)
                                  }
                                  onCheckedChange={(checked) =>
                                    field.onChange(
                                      question.type === "consent"
                                        ? checked === true
                                        : checked
                                          ? [
                                              ...(Array.isArray(field.value)
                                                ? field.value
                                                : []),
                                              choice.id,
                                            ]
                                          : (Array.isArray(field.value)
                                              ? field.value
                                              : []
                                            ).filter((id) => id !== choice.id),
                                    )
                                  }
                                />
                                <span className="min-w-0 break-words">
                                  {choice.label}
                                </span>
                              </label>
                            ))}
                          </div>
                        );
                      }
                      if (
                        ["single_choice", "yes_no", "rating"].includes(
                          question.type,
                        )
                      ) {
                        const options =
                          question.type === "single_choice"
                            ? question.choices.map((choice) => ({
                                value: choice.id,
                                label: choice.label,
                              }))
                            : question.type === "yes_no"
                              ? [
                                  { value: true, label: "Yes" },
                                  { value: false, label: "No" },
                                ]
                              : Array.from(
                                  {
                                    length:
                                      (question.maximum ?? 5) -
                                      (question.minimum ?? 1) +
                                      1,
                                  },
                                  (_, index) => ({
                                    value: index + (question.minimum ?? 1),
                                    label: String(
                                      index + (question.minimum ?? 1),
                                    ),
                                  }),
                                );
                        return (
                          <div
                            role="group"
                            aria-labelledby={`label-${question.id}`}
                            className="flex flex-wrap gap-2"
                          >
                            {options.map((option, index) => (
                              <Button
                                {...(index === 0 ? shared : { disabled })}
                                aria-labelledby={undefined}
                                aria-describedby={shared["aria-describedby"]}
                                aria-invalid={!!errors[question.id]}
                                ref={index === 0 ? field.ref : undefined}
                                key={String(option.value)}
                                type="button"
                                variant={
                                  field.value === option.value
                                    ? "secondary"
                                    : "outline"
                                }
                                className="h-auto min-h-11 max-w-full py-2 whitespace-normal text-left"
                                aria-pressed={field.value === option.value}
                                onClick={() => field.onChange(option.value)}
                              >
                                <span className="min-w-0 break-words">
                                  {option.label}
                                </span>
                              </Button>
                            ))}
                          </div>
                        );
                      }
                      if (question.type === "file")
                        return (
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">
                              Up to {question.maxFiles} files ·{" "}
                              {megabytes(maxFileBytes)} each ·{" "}
                              {question.fileTypes.join(", ")}
                            </p>
                            <input
                              type="file"
                              id={`upload-${question.id}`}
                              className="sr-only"
                              aria-hidden="true"
                              tabIndex={-1}
                              multiple={question.maxFiles > 1}
                              accept={question.fileTypes
                                .map((type) => fileAccept[type])
                                .join(",")}
                              disabled={disabled || preview}
                              onChange={(event) => {
                                const selected = Array.from(
                                  event.target.files ?? [],
                                );
                                event.target.value = "";
                                void upload(question, selected);
                              }}
                            />
                            <Button
                              {...shared}
                              ref={field.ref}
                              type="button"
                              variant="outline"
                              className="min-h-11"
                              aria-labelledby={`label-${question.id} choose-files-${question.id}`}
                              disabled={disabled || preview}
                              onClick={() =>
                                document
                                  .getElementById(`upload-${question.id}`)
                                  ?.click()
                              }
                            >
                              <FileUp />
                              <span id={`choose-files-${question.id}`}>
                                Choose files
                              </span>
                            </Button>
                            {preview && (
                              <p className="text-sm text-muted-foreground">
                                File uploads are available on the published
                                form.
                              </p>
                            )}
                            {(files[question.id] ?? []).map((file) => (
                              <div
                                key={file.id}
                                className="flex items-center gap-2 rounded-lg border px-3 py-2"
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {file.filename}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-11"
                                  disabled={disabled}
                                  aria-label={`Remove ${file.filename}`}
                                  onClick={() =>
                                    void removeFile(question.id, file.id)
                                  }
                                >
                                  <X />
                                </Button>
                              </div>
                            ))}
                            {fileErrors[question.id] && (
                              <p
                                role="alert"
                                className="text-sm text-destructive"
                              >
                                {fileErrors[question.id]}
                              </p>
                            )}
                          </div>
                        );
                      const numeric = question.type === "number";
                      const type = numeric
                        ? "number"
                        : ["email", "url", "date", "time"].includes(
                              question.type,
                            )
                          ? question.type
                          : question.type === "phone"
                            ? "tel"
                            : "text";
                      return (
                        <div className="flex items-center gap-2">
                          {question.type === "amount" && (
                            <span className="text-sm text-muted-foreground">
                              {question.currency}
                            </span>
                          )}
                          <Input
                            {...shared}
                            ref={field.ref}
                            type={type}
                            inputMode={
                              question.type === "amount" || numeric
                                ? "decimal"
                                : undefined
                            }
                            autoComplete={
                              question.type === "email"
                                ? "email"
                                : question.type === "phone"
                                  ? "tel"
                                  : "off"
                            }
                            min={numeric ? question.minimum : undefined}
                            max={numeric ? question.maximum : undefined}
                            step={numeric ? "any" : undefined}
                            maxLength={question.maxLength}
                            className="min-h-11"
                            value={
                              typeof field.value === "string" ||
                              typeof field.value === "number"
                                ? field.value
                                : ""
                            }
                            onChange={(event) =>
                              field.onChange(
                                numeric && event.target.value !== ""
                                  ? Number(event.target.value)
                                  : event.target.value,
                              )
                            }
                          />
                        </div>
                      );
                    }}
                  />
                  {errors[question.id]?.message && (
                    <p
                      id={`error-${question.id}`}
                      className="text-sm text-destructive"
                      role="alert"
                    >
                      {String(errors[question.id]?.message)}
                    </p>
                  )}
                </div>
              ),
            )}
          </fieldset>
          <div
            ref={feedback}
            tabIndex={-1}
            className="space-y-3 outline-none"
            aria-live="polite"
          >
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {uploading && (
              <p className="text-sm text-muted-foreground">Uploading files…</p>
            )}
            {!hydrated && (
              <span role="status" className="sr-only">
                Loading form…
              </span>
            )}
            <Button type="submit" disabled={disabled} className="min-h-11">
              {(!hydrated || isSubmitting) && (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              )}
              {preview
                ? "Try submission"
                : isSubmitting
                  ? "Submitting…"
                  : "Submit"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
