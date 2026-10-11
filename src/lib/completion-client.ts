"use client";
import { useEffect, useRef } from "react";
import { api } from "./client";
import { sectionCache } from "./section-cache";
export type Completion = {
  kind?: "artifact" | "bookmark" | "backup" | "content" | "ai";
  target?: string;
  status?: string;
};
function dispatch(detail: Completion) {
  if (detail.kind === "ai") {
    window.dispatchEvent(new CustomEvent("nivra:ai-completion", { detail }));
    return;
  }
  if (!detail.kind || detail.kind === "content") sectionCache.clear();
  else sectionCache.clear("artifacts:", "bookmarks:", "overview");
  window.dispatchEvent(new CustomEvent("nivra:completion", { detail }));
}
export function useCompletionStream(onRevoked: () => void) {
  const revoked = useRef(onRevoked);
  useEffect(() => {
    revoked.current = onRevoked;
  }, [onRevoked]);
  useEffect(() => {
    let stream: EventSource | undefined;
    let connected = false;
    let lastMessage = Date.now();
    let checkingSession = false;
    let active = true;
    const connect = () => {
      stream?.close();
      connected = false;
      lastMessage = Date.now();
      if (document.visibilityState === "hidden") return;
      stream = new EventSource("/api/v1/completions");
      stream.addEventListener("open", () => {
        connected = true;
      });
      stream.addEventListener("error", () => {
        connected = false;
        if (checkingSession) return;
        checkingSession = true;
        void api<{ owner: unknown }>("status")
          .then((status) => {
            if (active && !status.owner) {
              stream?.close();
              revoked.current();
            }
          })
          .catch(() => {})
          .finally(() => {
            checkingSession = false;
          });
      });
      const received = () => {
        connected = true;
        lastMessage = Date.now();
      };
      stream.addEventListener("heartbeat", received);
      stream.addEventListener("resync", () => {
        received();
        dispatch({});
      });
      stream.addEventListener("completion", (event) => {
        received();
        try {
          const detail = JSON.parse((event as MessageEvent).data) as Completion;
          if (
            ["artifact", "bookmark", "backup", "content", "ai"].includes(
              detail.kind || "",
            )
          )
            dispatch(detail);
        } catch {}
      });
      stream.addEventListener("revoked", () => {
        stream?.close();
        connected = false;
        revoked.current();
      });
    };
    const reconcile = () => {
      if (document.visibilityState === "visible") dispatch({});
    };
    const fallback = setInterval(() => {
      if (!connected || Date.now() - lastMessage > 30_000) reconcile();
    }, 30_000);
    const start = setTimeout(connect, 0);
    document.addEventListener("visibilitychange", connect);
    window.addEventListener("focus", reconcile);
    return () => {
      active = false;
      clearTimeout(start);
      clearInterval(fallback);
      stream?.close();
      document.removeEventListener("visibilitychange", connect);
      window.removeEventListener("focus", reconcile);
    };
  }, []);
}
export function useCompletion(
  kind: Completion["kind"],
  callback: (event: Completion) => void,
) {
  const handler = useRef(callback);
  useEffect(() => {
    handler.current = callback;
  }, [callback]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<Completion>).detail;
      if (
        !kind ||
        !detail.kind ||
        detail.kind === "content" ||
        detail.kind === kind
      )
        handler.current(detail);
    };
    window.addEventListener("nivra:completion", listener);
    if (kind === "ai") window.addEventListener("nivra:ai-completion", listener);
    return () => {
      window.removeEventListener("nivra:completion", listener);
      if (kind === "ai")
        window.removeEventListener("nivra:ai-completion", listener);
    };
  }, [kind]);
}
