"use client";
import { ConfirmProvider } from "./confirm-provider";
import { ThemeProvider } from "next-themes";
import { InlineFeedback } from "./inline-feedback";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { setNonce } from "get-nonce";
import { CspNonce, documentNonce } from "@/lib/csp";

function subscribeSystemTheme(changed: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}
function subscribeHydration() {
  return () => {};
}
// The server layout initializes theme; client remounts need no executable script.
export function Providers({
  children,
  nonce,
}: {
  children: React.ReactNode;
  nonce?: string;
}) {
  const currentNonce = documentNonce(nonce);
  const publicForm = usePathname().startsWith("/form/");
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false,
  );
  const systemTheme = useSyncExternalStore(
    subscribeSystemTheme,
    () =>
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    () => "light",
  );
  if (typeof window !== "undefined" && currentNonce) setNonce(currentNonce);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV === "production")
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    else
      navigator.serviceWorker
        .getRegistrations()
        .then(async (registrations) => {
          for (const registration of registrations) {
            const worker = registration.active || registration.waiting;
            if (worker?.scriptURL === `${location.origin}/sw.js`)
              await registration.unregister();
          }
          for (const name of await caches.keys())
            if (name.startsWith("nivra-static-")) await caches.delete(name);
        })
        .catch(() => {});
  }, []);
  return (
    <CspNonce.Provider value={currentNonce}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        nonce={currentNonce}
        storageKey="nivra-theme"
        forcedTheme={
          publicForm ? (hydrated ? systemTheme : "system") : undefined
        }
        scriptProps={{ type: "text/plain" }}
      >
        <InlineFeedback />
        <ConfirmProvider>{children}</ConfirmProvider>
      </ThemeProvider>
    </CspNonce.Provider>
  );
}
