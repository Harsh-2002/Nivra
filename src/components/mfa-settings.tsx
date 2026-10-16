"use client";
import { useState } from "react";
import Image from "next/image";
import { Download, Loader2, ShieldCheck } from "lucide-react";
import { notify } from "@/lib/feedback";
import { authRequest, download } from "@/lib/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
export function MfaSettings({
  enabled,
  beforeAction,
  onChanged,
  onGuardChange,
}: {
  enabled: boolean;
  beforeAction: () => Promise<boolean>;
  onChanged: (enabled: boolean) => void;
  onGuardChange: (guard: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{
    uri: string;
    qr: string;
    codes: string[];
  } | null>(null);
  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    onGuardChange(true);
    try {
      if (!(await beforeAction()))
        throw new Error("Save your note before changing security settings.");
      await action();
    } catch (e) {
      setError((e as Error).message);
      onGuardChange(verified);
    } finally {
      setBusy(false);
    }
  }
  const secret = setup ? new URL(setup.uri).searchParams.get("secret") : "";
  return (
    <div className="mfa-settings">
      <div className="settings-section-heading">
        <h2>
          {verified ? "Save your backup codes" : "Two-factor authentication"}
        </h2>
        <p>
          {verified
            ? "Each code works once if you lose your authenticator. Keep them somewhere private."
            : setup
              ? "Scan this code with your authenticator app, then verify its six-digit code."
              : enabled
                ? "Your authenticator adds a second step when you sign in."
                : "Add an authenticator code after your password. This is optional."}
        </p>
      </div>
      {verified && setup ? (
        <>
          <div className="mfa-backup-codes">
            {setup.codes.map((item) => (
              <code key={item}>{item}</code>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={() => {
              download(
                new Blob(
                  [
                    `Nivra MFA backup codes\n\n${setup.codes.join("\n")}\n\nEach code is single-use. Keep these private.\n`,
                  ],
                  { type: "text/plain" },
                ),
                "nivra-mfa-backup-codes.txt",
              );
              setSaved(true);
            }}
          >
            <Download size={15} />
            Download backup codes
          </Button>
          <label className="check-row">
            <Checkbox
              checked={saved}
              onCheckedChange={(value) => setSaved(value === true)}
            />
            I saved my backup codes
          </label>
          <Button
            disabled={!saved}
            onClick={() => {
              setSetup(null);
              setVerified(false);
              onGuardChange(false);
              notify.success("Two-factor authentication enabled.");
            }}
          >
            Done
          </Button>
        </>
      ) : setup ? (
        <>
          <div className="mfa-qr">
            <Image
              unoptimized
              src={setup.qr}
              alt="Authenticator setup QR code"
              width={180}
              height={180}
            />
          </div>
          <div className="mfa-manual">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showSecret}
              onClick={() => setShowSecret(!showSecret)}
            >
              Enter the setup key manually
            </Button>
            {showSecret && (
              <>
                <Label htmlFor="mfa-secret">Setup key</Label>
                <Input
                  id="mfa-secret"
                  readOnly
                  value={secret || ""}
                  onFocus={(e) => e.target.select()}
                />
                <p className="field-hint">
                  Time-based code · 6 digits · 30 seconds
                </p>
              </>
            )}
          </div>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await authRequest("two-factor/verify-totp", {
                  code,
                  trustDevice: false,
                });
                await authRequest("revoke-other-sessions", {});
                setVerified(true);
                setPassword("");
                setCode("");
                onChanged(true);
              });
            }}
          >
            <div className="field">
              <Label htmlFor="enrollment-code">Authentication code</Label>
              <Input
                id="enrollment-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />}Verify and
              enable
            </Button>
          </form>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setSetup(null);
              setCode("");
              setPassword("");
              onGuardChange(false);
            }}
          >
            Cancel setup
          </Button>
        </>
      ) : (
        <>
          <p className="mfa-status">
            <ShieldCheck size={17} />
            {enabled ? "Enabled" : "Not enabled"}
          </p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (enabled) {
                  await authRequest("two-factor/disable", { password });
                  await authRequest("revoke-other-sessions", {});
                  onChanged(false);
                  setPassword("");
                  onGuardChange(false);
                  notify.success("Two-factor authentication disabled.");
                } else {
                  const result = await authRequest("two-factor/enable", {
                    password,
                    method: "totp",
                  });
                  if (result.method !== "totp")
                    throw new Error("Authenticator setup was not available.");
                  setSetup({
                    uri: result.totpURI,
                    qr: await (
                      await import("qrcode")
                    ).default.toDataURL(result.totpURI, {
                      width: 180,
                      margin: 2,
                    }),
                    codes: result.backupCodes,
                  });
                  onGuardChange(false);
                }
              });
            }}
          >
            <div className="field">
              <Label htmlFor="mfa-password">Current password</Label>
              <Input
                id="mfa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant={enabled ? "outline" : "default"}
              disabled={busy}
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {enabled
                ? "Disable two-factor authentication"
                : "Set up authenticator"}
            </Button>
          </form>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
