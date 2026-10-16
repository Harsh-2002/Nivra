"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RefreshCw } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { api } from "@/lib/client";
import type { Owner, Settings } from "@/lib/types";
import {
  getPwaInstallServerSnapshot,
  getPwaInstallSnapshot,
  subscribePwaInstall,
} from "@/lib/onboarding";
import { LaunchScreen } from "./launch-screen";
import { AuthScreen, Mark } from "./auth-screen";
import { WorkspaceOnboarding } from "./workspace-onboarding";
import { Button } from "./ui/button";
import type { WorkspaceView } from "@/lib/workspace-routes";
const loadWorkspace = () =>
  import("./workspace").then((module) => module.Workspace);
const Workspace = dynamic(loadWorkspace, {
  ssr: false,
  loading: () => <LaunchScreen />,
});
export function Nivra({
  initialView = "overview",
  signedIn = false,
}: {
  initialView?: WorkspaceView;
  signedIn?: boolean;
}) {
  const [status, setStatus] = useState<{
    setup: boolean;
    installation?: { encrypted: boolean; locked: boolean; publicUrl: string };
    methods: { password: boolean; passkey: boolean };
    owner: Owner | null;
    settings: Settings | null;
  } | null>(null);
  const [error, setError] = useState("");
  const signingOut = useRef(false);
  const mounted = useRef(true);
  const statusRequest = useRef<AbortController | null>(null);
  const { setTheme } = useTheme();
  const setThemeRef = useRef(setTheme);
  const install = useSyncExternalStore(
    subscribePwaInstall,
    getPwaInstallSnapshot,
    getPwaInstallServerSnapshot,
  );
  useEffect(() => {
    setThemeRef.current = setTheme;
  }, [setTheme]);
  useEffect(() => {
    if (signedIn) loadWorkspace().catch(() => {});
  }, [signedIn]);
  const refresh = useCallback(async () => {
    await Promise.resolve();
    if (!mounted.current) return false;
    statusRequest.current?.abort();
    const request = new AbortController();
    statusRequest.current = request;
    setError("");
    try {
      const result = await api<NonNullable<typeof status>>("status", {
        signal: request.signal,
      });
      if (!mounted.current || request.signal.aborted) return false;
      setStatus(result);
      if (result.settings) setThemeRef.current(result.settings.theme);
      return true;
    } catch (e) {
      if (mounted.current && !request.signal.aborted)
        setError((e as Error).message);
      return false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      clearTimeout(timer);
      mounted.current = false;
      statusRequest.current?.abort();
    };
  }, [refresh]);
  if (!status && !error) return <LaunchScreen />;
  if (!status)
    return (
      <main className="loading-page">
        <Mark />
        <p role="alert">{error}</p>
        <Button variant="outline" onClick={refresh}>
          <RefreshCw size={16} />
          Try again
        </Button>
      </main>
    );
  if (
    status.owner &&
    status.settings?.onboardingStep &&
    status.settings.onboardingStep !== "complete"
  )
    return (
      <WorkspaceOnboarding
        initialStep={status.settings?.onboardingStep ?? "tags"}
        install={install}
        onComplete={refresh}
      />
    );
  return status.owner ? (
    <Workspace
      initialView={initialView}
      owner={status.owner}
      initialSettings={status.settings!}
      onSignOut={() => {
        if (signingOut.current) return;
        signingOut.current = true;
        window.location.replace("/");
      }}
    />
  ) : (
    <AuthScreen
      setup={status.setup}
      installation={status.installation}
      methods={status.methods}
      onReady={refresh}
    />
  );
}
