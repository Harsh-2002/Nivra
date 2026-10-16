"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { notify } from "@/lib/feedback";

type Feedback = { message: string; tone: "status" | "error" };
export function FeedbackOutlet() {
  return <div className="feedback-slot" />;
}
export function InlineFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [target, setTarget] = useState<Element | null>(null);
  const message = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!feedback || !target) return;
    const frame = requestAnimationFrame(() => {
      const node = message.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const region = node
        .closest<HTMLElement>(
          '.tasks-scroll,.notes-list,.writing-surface,.settings-content,[data-slot="dialog-content"]',
        )
        ?.getBoundingClientRect();
      const top = Math.max(0, region?.top ?? 0);
      const bottom = Math.min(innerHeight, region?.bottom ?? innerHeight);
      if (box.top < top || box.bottom > bottom)
        node.scrollIntoView({
          block: "nearest",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [feedback, target]);
  useEffect(() => {
    const receive = (event: Event) =>
      setFeedback((event as CustomEvent<Feedback | null>).detail);
    const place = () => {
      const dialogs = document.querySelectorAll(
        '[data-slot="dialog-content"] .feedback-slot,.mobile-app-page .feedback-slot',
      );
      const slots = document.querySelectorAll(
        ".section-heading .feedback-slot,.writing-surface > .feedback-slot,.notes-list > .feedback-slot",
      );
      if (!dialogs.length && !slots.length) setFeedback(null);
      setTarget(
        dialogs.length
          ? dialogs[dialogs.length - 1]
          : (slots[slots.length - 1] ?? null),
      );
    };
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("nivra:feedback", receive);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener("nivra:feedback", receive);
    };
  }, []);
  return feedback && target
    ? createPortal(
        <div
          ref={message}
          className="inline-feedback"
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          <p>{feedback.message}</p>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss notification"
            onClick={notify.dismiss}
          >
            <X size={16} />
          </Button>
        </div>,
        target,
      )
    : null;
}
