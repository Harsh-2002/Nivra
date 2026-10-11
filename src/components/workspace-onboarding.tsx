"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Download } from "lucide-react";
import { api, apiItems, type ApiError } from "@/lib/client";
import type { Settings, Tag } from "@/lib/types";
import {
  ONBOARDING_INTERESTS,
  getInterestsFromTagNames,
  getSuggestedTags,
  normalizeTagName,
  parseTagAliases,
  promptPwaInstall,
  type PwaInstallSnapshot,
} from "@/lib/onboarding";
import { Mark } from "./auth-screen";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type OnboardingStep = "tags" | "install";

export function WorkspaceOnboarding({
  initialStep,
  install,
  onComplete,
}: {
  initialStep: OnboardingStep;
  install: PwaInstallSnapshot;
  onComplete: () => Promise<boolean>;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const [interestsEdited, setInterestsEdited] = useState(false);
  const [tagName, setTagName] = useState("");
  const [aliases, setAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void apiItems<Tag>("tags", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setTags(result);
          setTagsError("");
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setTagsError((cause as Error).message || "Could not load your tags.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setTagsLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const existingTagNames = useMemo(
    () => new Set(tags.map((tag) => normalizeTagName(tag.name))),
    [tags],
  );
  const selectedInterests = useMemo(
    () =>
      interestsEdited
        ? interests
        : getInterestsFromTagNames(tags.map((tag) => tag.name)),
    [interests, interestsEdited, tags],
  );
  const suggestions = useMemo(
    () =>
      getSuggestedTags(selectedInterests).filter(
        (name) => !existingTagNames.has(normalizeTagName(name)),
      ),
    [existingTagNames, selectedInterests],
  );
  const duplicateName =
    tagName.trim() && existingTagNames.has(normalizeTagName(tagName));

  function clearNotice() {
    setError("");
    setMessage("");
  }

  async function reloadTags() {
    setTagsLoading(true);
    setTagsError("");
    try {
      const result = await apiItems<Tag>("tags");
      setTags(result);
      return result;
    } catch (cause) {
      setTagsError((cause as Error).message || "Could not load your tags.");
      return null;
    } finally {
      setTagsLoading(false);
    }
  }

  async function addTag(name: string, tagAliases: string[] = []) {
    const cleanedName = name.normalize("NFKC").trim();
    if (!cleanedName) {
      setError("Enter a tag name.");
      setMessage("");
      return;
    }
    if (existingTagNames.has(normalizeTagName(cleanedName))) {
      setMessage(
        `“${cleanedName}” is already in your tags. It was left unchanged.`,
      );
      setError("");
      return;
    }
    if (tagsLoading || tagsError) {
      setError("Load your current tags before adding another.");
      setMessage("");
      return;
    }
    if (busy) return;

    clearNotice();
    setBusy(true);
    try {
      const created = await api<Tag>("tags", {
        method: "POST",
        body: JSON.stringify({
          name: cleanedName,
          color: "gray",
          aliases: tagAliases,
        }),
      });
      setTags((current) => [...current, created]);
      setMessage(`Added “${created.name}”. You can add another or continue.`);
      if (normalizeTagName(tagName) === normalizeTagName(cleanedName)) {
        setTagName("");
        setAliases("");
      }
    } catch (cause) {
      const refreshed = await reloadTags();
      if (
        refreshed?.some(
          (tag) => normalizeTagName(tag.name) === normalizeTagName(cleanedName),
        )
      ) {
        setError("");
        setMessage(`“${cleanedName}” is already in your tags.`);
      } else {
        setError((cause as ApiError).message || "This tag could not be added.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveStep(next: "tags" | "install" | "complete") {
    if (busy || installBusy) return;
    clearNotice();
    setBusy(true);
    try {
      await api<Settings>("settings", {
        method: "PATCH",
        body: JSON.stringify({ onboardingStep: next }),
      });
      if (next === "complete") {
        const refreshed = await onComplete();
        if (!refreshed)
          setError(
            "Setup is saved, but Nivra could not refresh. Reload to continue.",
          );
      } else {
        setStep(next);
      }
    } catch (cause) {
      setError(
        `Could not save setup progress. ${(cause as Error).message || "Try again."}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function installApp() {
    if (installBusy || !install.prompt) return;
    clearNotice();
    setInstallBusy(true);
    try {
      const outcome = await promptPwaInstall();
      if (outcome === "accepted")
        setMessage(
          "The browser accepted the install request. Follow its next steps to finish.",
        );
      else if (outcome === "dismissed")
        setMessage(
          "No changes were made. You can still use the browser’s install menu later.",
        );
      else
        setMessage(
          "The browser prompt is no longer available. Use the install instructions below.",
        );
    } catch {
      setMessage(
        "The browser prompt closed. You can still use the install instructions below.",
      );
    } finally {
      setInstallBusy(false);
    }
  }

  const visibleStep = step === "tags" ? 6 : 7;
  return (
    <main className="auth-page workspace-onboarding-page">
      <section className="auth-panel workspace-onboarding-panel">
        <div
          className="setup-progress"
          role="group"
          aria-label={`Setup step ${visibleStep} of 7`}
        >
          {Array.from({ length: 7 }, (_, index) => (
            <span
              key={index}
              className={index < visibleStep ? "complete" : ""}
              aria-hidden="true"
            />
          ))}
        </div>
        <Mark />
        {step === "tags" ? (
          <>
            <h1 ref={heading} tabIndex={-1}>
              Choose your starting tags
            </h1>
            <p className="auth-description">
              Pick a few areas to see suggestions. Nothing is added until you
              choose Add. Your tags stay editable later.
            </p>
            <fieldset className="onboarding-interests">
              <legend>What would you like to organize?</legend>
              {ONBOARDING_INTERESTS.map((interest) => (
                <Label key={interest} className="onboarding-interest">
                  <Checkbox
                    checked={selectedInterests.includes(interest)}
                    onCheckedChange={(checked) => {
                      clearNotice();
                      setInterestsEdited(true);
                      setInterests((currentState) => {
                        const current = interestsEdited
                          ? currentState
                          : getInterestsFromTagNames(
                              tags.map((tag) => tag.name),
                            );
                        return checked
                          ? [...current, interest]
                          : current.filter((item) => item !== interest);
                      });
                    }}
                  />
                  {interest}
                </Label>
              ))}
            </fieldset>
            <section
              className="onboarding-suggestions"
              aria-labelledby="onboarding-suggestions-title"
            >
              <h2 id="onboarding-suggestions-title">Suggested tags</h2>
              {tagsLoading ? (
                <p className="field-hint" role="status">
                  Loading your current tags…
                </p>
              ) : tagsError ? (
                <div className="onboarding-inline-error" role="alert">
                  <p>Could not load your current tags. {tagsError}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      clearNotice();
                      void reloadTags();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : selectedInterests.length ? (
                suggestions.length ? (
                  <ul className="onboarding-tag-list">
                    {suggestions.map((suggestion) => (
                      <li key={suggestion}>
                        <span>{suggestion}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`Add ${suggestion}`}
                          onClick={() => void addTag(suggestion, [])}
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="field-hint">You already have these tags.</p>
                )
              ) : (
                <p className="field-hint">
                  Choose an area above to see suggestions.
                </p>
              )}
              {tags.length > 0 && !tagsLoading && !tagsError && (
                <p className="onboarding-existing-tags" role="status">
                  Already added: {tags.map((tag) => tag.name).join(", ")}
                </p>
              )}
            </section>
            <form
              className="onboarding-custom-tag"
              onSubmit={(event) => {
                event.preventDefault();
                const parsedAliases = parseTagAliases(aliases, tagName);
                if (
                  parsedAliases.length > 10 ||
                  parsedAliases.some((alias) => alias.length > 80)
                ) {
                  setError(
                    "Use up to 10 aliases, each no longer than 80 characters.",
                  );
                  setMessage("");
                  return;
                }
                void addTag(tagName, parsedAliases);
              }}
            >
              <h2>Add a custom tag</h2>
              <div className="field">
                <Label htmlFor="onboarding-tag-name">Tag name</Label>
                <Input
                  id="onboarding-tag-name"
                  value={tagName}
                  maxLength={50}
                  autoComplete="off"
                  onChange={(event) => {
                    clearNotice();
                    setTagName(event.target.value);
                  }}
                />
                {duplicateName && (
                  <p className="field-hint" role="status">
                    That tag already exists and will not be duplicated.
                  </p>
                )}
              </div>
              <div className="field">
                <Label htmlFor="onboarding-tag-aliases">
                  Aliases (optional)
                </Label>
                <Input
                  id="onboarding-tag-aliases"
                  value={aliases}
                  maxLength={809}
                  autoComplete="off"
                  placeholder="Comma-separated words"
                  onChange={(event) => {
                    clearNotice();
                    setAliases(event.target.value);
                  }}
                />
                <p className="field-hint">
                  Use up to 10 comma-separated aliases, 80 characters each.
                </p>
              </div>
              <Button
                type="submit"
                variant="outline"
                disabled={
                  busy ||
                  tagsLoading ||
                  !!tagsError ||
                  !tagName.trim() ||
                  !!duplicateName
                }
              >
                {busy ? "Saving…" : "Add tag"}
              </Button>
            </form>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p
                className="onboarding-success"
                role="status"
                aria-live="polite"
              >
                <Check size={16} aria-hidden="true" /> {message}
              </p>
            )}
            <div className="onboarding-actions">
              <Button
                type="button"
                className="w-full"
                disabled={busy || installBusy}
                onClick={() => void saveStep("install")}
              >
                Continue
                <ArrowRight size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={busy || installBusy}
                onClick={() => void saveStep("install")}
              >
                Skip tag setup
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 ref={heading} tabIndex={-1}>
              Install Nivra on this device
            </h1>
            <p className="auth-description">
              Add Nivra to your home screen or app list for a separate window
              and an easy way back. Your notes remain on your Nivra server.
            </p>
            {install.installed || install.standalone ? (
              <p className="onboarding-installed" role="status">
                <Check size={17} aria-hidden="true" />
                {install.standalone
                  ? "Nivra is already open as an app on this device."
                  : "Nivra is installed on this device."}
              </p>
            ) : !install.secure ? (
              <p className="onboarding-secure-note" role="status">
                App installation requires a secure connection. Open Nivra over
                HTTPS; localhost is also treated as secure for local use.
              </p>
            ) : (
              <>
                {install.prompt && (
                  <Button
                    type="button"
                    className="w-full onboarding-install-button"
                    disabled={installBusy}
                    onClick={() => void installApp()}
                  >
                    <Download size={16} />
                    {installBusy ? "Opening install prompt…" : "Install Nivra"}
                  </Button>
                )}
                <div className="onboarding-install-instructions">
                  <h2>Install from your browser</h2>
                  {install.platform === "ios" ? (
                    <p>
                      On an iPhone or iPad, open Nivra in Safari. Tap Share,
                      then choose Add to Home Screen.
                    </p>
                  ) : install.platform === "android" ? (
                    <p>
                      In Chrome, open the browser menu and choose Install app or
                      Add to Home screen.
                    </p>
                  ) : (
                    <>
                      <p>
                        In a Chromium browser, use the install icon in the
                        address bar or choose Install Nivra from the browser
                        menu when it is available.
                      </p>
                      <p>
                        On macOS Sonoma 14 or later, Safari can add Nivra from
                        File → Add to Dock or Share → Add to Dock.
                      </p>
                    </>
                  )}
                  {!install.prompt && install.platform !== "ios" && (
                    <p className="field-hint">
                      This browser does not currently offer an install prompt.
                      Check its menu for an install option.
                    </p>
                  )}
                </div>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p
                className="onboarding-success"
                role="status"
                aria-live="polite"
              >
                <Check size={16} aria-hidden="true" /> {message}
              </p>
            )}
            <div className="onboarding-actions">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy || installBusy}
                onClick={() => void saveStep("tags")}
              >
                <ArrowLeft size={16} /> Back to tag setup
              </Button>
              <Button
                type="button"
                className="w-full"
                disabled={busy || installBusy}
                onClick={() => void saveStep("complete")}
              >
                Finish setup
                <ArrowRight size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={busy || installBusy}
                onClick={() => void saveStep("complete")}
              >
                Skip install guidance
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
