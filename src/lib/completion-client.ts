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
    let checkingSession: EventSource | undefined;
    let active = true;
    const connect = () => {
      if (!active) return;
      const previous = stream;
      stream = undefined;
      connected = false;
      lastMessage = Date.now();
      previous?.close();
      if (document.visibilityState === "hidden") return;
      const source = new EventSource("/api/v1/completions");
      stream = source;
      source.addEventListener("open", () => {
        if (!active || stream !== source) return;
        connected = true;
      });
      source.addEventListener("error", () => {
        if (
          !active ||
          stream !== source ||
          document.visibilityState === "hidden"
        )
          return;
        connected = false;
        if (checkingSession === source) return;
        checkingSession = source;
        void api<{ owner: unknown }>("status")
          .then((status) => {
            if (
              active &&
              stream === source &&
              document.visibilityState !== "hidden" &&
              !status.owner
            ) {
              stream = undefined;
              source.close();
              revoked.current();
            }
          })
          .catch(() => {})
          .finally(() => {
            if (checkingSession === source) checkingSession = undefined;
          });
      });
      const received = () => {
        connected = true;
        lastMessage = Date.now();
      };
      source.addEventListener("heartbeat", () => {
        if (active && stream === source) received();
      });
      source.addEventListener("resync", () => {
        if (!active || stream !== source) return;
        received();
        dispatch({});
      });
      source.addEventListener("completion", (event) => {
        if (!active || stream !== source) return;
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
      source.addEventListener("revoked", () => {
        if (!active || stream !== source) return;
        stream = undefined;
        source.close();
        connected = false;
        revoked.current();
      });
    };
    const reconcile = () => {
      if (active && document.visibilityState === "visible") dispatch({});
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
      const current = stream;
      stream = undefined;
      current?.close();
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
