"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { AuthScreen, Mark } from "./auth-screen";
import { LaunchScreen } from "./launch-screen";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
type Status = {
  setup: boolean;
  owner: unknown;
  methods: { password: boolean; passkey: boolean };
};
const idPattern = /^[a-p]{32}$/;
export function ExtensionConnect() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [deviceEdit, setDeviceEdit] = useState<string | null>(null);
  // Rendered only after the status request, so the server render never reads these.
  const query =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const params = {
    extension: query.get("extension") || "",
    state: (query.get("state") || "").slice(0, 200),
    flow: query.get("flow") === "web" ? "web" : "code",
  };
  const device =
    deviceEdit ??
    ((query.get("name") || "Chrome").trim().slice(0, 60) || "Chrome");
  const valid = idPattern.test(params.extension);
  useEffect(() => {
    api<Status>("status")
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);
  async function allow() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ code: string }>("extension/authorize", {
        method: "POST",
        body: JSON.stringify({
          extensionId: params.extension,
          deviceName: device.trim() || "Chrome",
        }),
      });
      if (params.flow === "web") {
        const target = new URL(`https://${params.extension}.chromiumapp.org/`);
        target.hash = new URLSearchParams({
          code: result.code,
          state: params.state,
        }).toString();
        window.location.assign(target.href);
        return;
      }
      setCode(result.code);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  if (!status && !error) return <LaunchScreen />;
  if (status && !status.owner && !status.setup)
    return (
      <AuthScreen
        setup={false}
        methods={status.methods}
        onReady={() => {
          void api<Status>("status").then(setStatus);
        }}
      />
    );
  return (
    <main className="auth-page">
      <section className="auth-panel oauth-card">
        <header className="oauth-heading">
          <Mark />
          <h1>Connect your browser</h1>
          <p>
            Allow the Nivra browser extension to save bookmarks and quick notes
            to this instance.
          </p>
        </header>
        {status?.setup && (
          <p>Set up your Nivra account before connecting a browser.</p>
        )}
        {status && !status.setup && !valid && (
          <p role="alert" className="form-error">
            This link is incomplete. Start again from the extension.
          </p>
        )}
        {status && !status.setup && valid && !code && (
          <>
            <Field>
              <FieldLabel htmlFor="extension-device">Device name</FieldLabel>
              <Input
                id="extension-device"
                value={device}
                maxLength={60}
                disabled={busy}
                onChange={(event) => setDeviceEdit(event.target.value)}
              />
              <FieldDescription>
                Shown in Settings → MCP so you can revoke this browser later.
              </FieldDescription>
            </Field>
            <ul className="oauth-access-summary">
              <li>Save links and notes you send from the browser.</li>
              <li>Add tags, collections and a note to saved links.</li>
              <li>Cannot read settings or permanently delete anything.</li>
            </ul>
            <p className="oauth-note">Extension ID: {params.extension}</p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <footer className="oauth-footer">
              <div className="oauth-decisions">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    window.location.assign(
                      new URL("/", window.location.href).href,
                    )
                  }
                >
                  Cancel
                </Button>
                <Button onClick={() => void allow()} disabled={busy}>
                  {busy ? "Connecting…" : "Connect browser"}
                </Button>
              </div>
            </footer>
          </>
        )}
        {code && (
          <Field>
            <FieldLabel htmlFor="extension-code">Pairing code</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="extension-code"
                readOnly
                value={code}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(code)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <FieldDescription role="status">
              Paste this into the extension within 2 minutes. It works once.
            </FieldDescription>
          </Field>
        )}
        {error && !valid && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
