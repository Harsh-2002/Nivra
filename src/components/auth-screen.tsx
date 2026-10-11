"use client";
import { SystemSettings } from "./system-settings";
import { brandPath, brandFramePath, brandTagline } from "@/lib/brand";
import { MfaSettings } from "./mfa-settings";
import { useState, useEffect, useRef } from "react";
import { isLoginIdentifier } from "@/lib/login-identifier";
import {
  passkeyAuth,
  usePasskeySupported,
  passkeyCancelled,
} from "@/lib/passkey-client";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  Download,
  Eye,
  EyeOff,
  Loader2,
  KeyRound,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Checkbox } from "./ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, authRequest, download } from "@/lib/client";
import type { Settings } from "@/lib/types";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="currentColor">
        <path d={brandFramePath} />
        <path d={brandPath} fill="var(--background)" />
      </svg>
    </span>
  );
}
export function RecoveryCard({
  code,
  onDone,
  doneLabel = "Continue",
}: {
  code: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <div className="step-symbol">
        <Check size={23} />
      </div>
      <h1>Keep your way back in.</h1>
      <p className="auth-description">
        Your recovery code lets you reset your password. Save it somewhere safe
        — it’s only shown once.
      </p>
      <code className="recovery-code">{code}</code>
      <Button
        variant="outline"
        className="w-full"
        onClick={() => {
          download(
            new Blob(
              [
                `Nivra recovery code\n\n${code}\n\nKeep this private. Using it resets your password and replaces the code.\n`,
              ],
              { type: "text/plain" },
            ),
            "nivra-recovery-code.txt",
          );
          setSaved(true);
        }}
      >
        <Download size={16} />
        Download recovery code
      </Button>
      <label className="check-row">
        <Checkbox
          checked={saved}
          onCheckedChange={(value) => setSaved(value === true)}
        />
        I have saved my recovery code
      </label>
      <Button className="w-full" disabled={!saved} onClick={onDone}>
        {doneLabel}
        <ArrowRight size={16} />
      </Button>
    </>
  );
}
export function AuthScreen({
  setup,
  installation: initialInstallation,
  methods,
  onReady,
  continuationError,
  oauthQuery,
}: {
  setup: boolean;
  installation?: { encrypted: boolean; locked: boolean; publicUrl: string };
  methods: { password: boolean; passkey: boolean };
  onReady: (result?: { url?: string; redirect_uri?: string }) => void;
  continuationError?: string;
  oauthQuery?: string;
}) {
  const [installation, setInstallation] = useState(initialInstallation);
  const [encrypted, setEncrypted] = useState(
    initialInstallation?.encrypted ?? true,
  );
  const [setupMethod, setSetupMethod] = useState<"password" | "passkey">(
    "password",
  );
  const [mfaSetup, setMfaSetup] = useState(false);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [mfaGuard, setMfaGuard] = useState(false);
  const [step, setStep] = useState(0);
  const [setupStage, setSetupStage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (setup && setupStage > 0 && step === 0) heading.current?.focus();
  }, [setup, setupStage, step]);
  const [mfa, setMfa] = useState(false);
  const [backup, setBackup] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const passkeysSupported = usePasskeySupported();
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const { theme } = useTheme();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (setup && setupStage === 0) {
      if (!name.trim() || !isLoginIdentifier(username.trim())) {
        setError("Enter your name and a valid username or email address.");
        return;
      }
      setName(name.trim());
      setUsername(username.trim());
      setSetupStage(1);
      return;
    }
    if (
      ((setup && setupMethod === "password") || recovering) &&
      password !== confirm
    ) {
      setError("Your passwords don’t match.");
      return;
    }
    if (setup && setupStage === 1) {
      if (
        setupMethod === "password" &&
        (password.length < 12 || password.length > 128)
      ) {
        setError("Use a password between 12 and 128 characters.");
        return;
      }
      if (setupMethod === "passkey" && !passkeysSupported) {
        setError("Passkeys need a supported browser and HTTPS or localhost.");
        return;
      }
      setSetupStage(2);
      return;
    }
    setBusy(true);
    try {
      if (setup) {
        let result: { recoveryCode: string };
        if (setupMethod === "passkey") {
          const intent = await api<{ context: string; recoveryCode: string }>(
            "setup-passkey",
            {
              method: "POST",
              body: JSON.stringify({ name, username, encrypted }),
            },
          );
          try {
            const registered = await passkeyAuth.passkey.addPasskey({
              context: intent.context,
              createSession: true,
              name: "Primary passkey",
            });
            if (registered.error)
              throw new Error(
                passkeyCancelled(registered.error)
                  ? "Passkey creation was cancelled. Try again or choose password."
                  : registered.error.message ||
                      "Passkey creation failed. Try again.",
              );
            result = { recoveryCode: intent.recoveryCode };
          } finally {
            await api("setup-passkey/cancel", {
              method: "POST",
              body: JSON.stringify({ context: intent.context }),
            }).catch(() => {});
          }
        } else
          result = await api<{ recoveryCode: string }>("setup", {
            method: "POST",
            body: JSON.stringify({ name, username, password, encrypted }),
          });
        setRecoveryCode(result.recoveryCode);
        setPassword("");
        setConfirm("");
        setStep(1);
      } else if (recovering) {
        const result = await api<{ recoveryCode: string }>("recover", {
          method: "POST",
          body: JSON.stringify({ code, password }),
        });
        setRecoveryCode(result.recoveryCode);
        setPassword("");
        setConfirm("");
        setStep(1);
      } else {
        const result = await authRequest("sign-in/username", {
          username,
          password,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        });
        setPassword("");
        if (result.twoFactorRedirect) setMfa(true);
        else onReady(result);
      }
    } catch (e) {
      setError((e as Error).message);
      if (setup) {
        try {
          const current = await api<{
            installation: NonNullable<typeof installation>;
          }>("status");
          setInstallation(current.installation);
          setEncrypted(current.installation.encrypted);
        } catch {}
      }
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api<Settings>("settings", {
        method: "PATCH",
        body: JSON.stringify({
          theme: theme || "system",
        }),
      });
      onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-panel">
        {setup && (
          <div
            className="setup-progress"
            role="group"
            aria-label={`Setup step ${step === 0 ? setupStage + 1 : step + 3} of 7`}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <span
                key={i}
                className={
                  i <= (step === 0 ? setupStage : step + 2) ? "complete" : ""
                }
              />
            ))}
          </div>
        )}
        {mfa ? (
          <>
            <h1>One more step.</h1>
            <p className="auth-description">
              {backup
                ? "Enter one of your saved backup codes."
                : "Enter the six-digit code from your authenticator app."}
            </p>
            <form
              className="auth-form"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                void authRequest(
                  backup
                    ? "two-factor/verify-backup-code"
                    : "two-factor/verify-totp",
                  {
                    code: mfaCode,
                    trustDevice: false,
                    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
                  },
                )
                  .then(onReady)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <div className="field">
                <Label htmlFor="mfa-code">
                  {backup ? "Backup code" : "Authentication code"}
                </Label>
                <Input
                  id="mfa-code"
                  value={mfaCode}
                  autoComplete="one-time-code"
                  inputMode={backup ? "text" : "numeric"}
                  pattern={backup ? undefined : "[0-9]{6}"}
                  maxLength={backup ? 32 : 6}
                  required
                  autoFocus
                  onChange={(e) => setMfaCode(e.target.value.trim())}
                />
              </div>
              {(error || continuationError) && (
                <p className="form-error" role="alert">
                  {error || continuationError}
                </p>
              )}
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 size={16} className="animate-spin" />}Verify
                and sign in
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBackup(!backup);
                  setMfaCode("");
                  setError("");
                }}
              >
                {backup ? "Use authenticator code" : "Use a backup code"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setMfa(false);
                  setMfaCode("");
                  setError("");
                }}
              >
                Back to sign in
              </Button>
            </form>
          </>
        ) : step === 1 ? (
          <RecoveryCard
            code={recoveryCode}
            onDone={() => {
              if (setup) setStep(2);
              else {
                setStep(0);
                setRecovering(false);
                setCode("");
              }
            }}
            doneLabel={setup ? "Make it yours" : "Back to sign in"}
          />
        ) : step === 2 ? (
          <>
            <h1>Finish setup.</h1>
            <p className="auth-description">
              Local storage is ready. Configure S3 now or later in Settings →
              System.
            </p>
            {setupMethod === "password" &&
              (mfaSetup ? (
                <MfaSettings
                  enabled={mfaEnrolled}
                  beforeAction={async () => true}
                  onChanged={setMfaEnrolled}
                  onGuardChange={(guard) => {
                    setMfaGuard(guard);
                    if (!guard && mfaEnrolled) setMfaSetup(false);
                  }}
                />
              ) : (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={mfaEnrolled}
                  onClick={() => setMfaSetup(true)}
                >
                  {mfaEnrolled
                    ? "Authenticator enabled"
                    : "Add an authenticator (optional)"}
                </Button>
              ))}
            <p className="field-hint">
              You can add{" "}
              {setupMethod === "password"
                ? "passkeys"
                : "a password and an authenticator"}{" "}
              in Settings → Account.
            </p>
            {!mfaGuard && <SystemSettings onboarding onDone={finish} />}
          </>
        ) : (
          <>
            <Mark />
            <h1 ref={heading} tabIndex={-1}>
              {setup
                ? setupStage === 0
                  ? brandTagline
                  : setupStage === 1
                    ? "Choose how to sign in."
                    : "Protect your data."
                : recovering
                  ? "Find your way back."
                  : "Welcome back."}
            </h1>
            <p className="auth-description">
              {setup
                ? setupStage === 0
                  ? "Let’s start with your name and login identifier."
                  : setupStage === 1
                    ? "Choose a password or a passkey for your account."
                    : "Choose how Nivra stores your content before creating your account."
                : recovering
                  ? "Use your saved recovery code to set a new password. Registered passkeys stay valid; remove unwanted keys in Settings after signing in."
                  : "Pick up where your thoughts left off."}
            </p>
            {!setup && !recovering && methods.passkey && (
              <div className="auth-passkeys">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={!passkeysSupported || busy}
                  onClick={() => {
                    setBusy(true);
                    setPasskeyBusy(true);
                    setError("");
                    void passkeyAuth.signIn
                      .passkey(
                        oauthQuery
                          ? {
                              fetchOptions: {
                                onRequest: (context) => {
                                  const body =
                                    typeof context.body === "string"
                                      ? JSON.parse(context.body)
                                      : context.body;
                                  context.body = JSON.stringify({
                                    ...body,
                                    oauth_query: oauthQuery,
                                  });
                                  return context;
                                },
                              },
                            }
                          : undefined,
                      )
                      .then((result) => {
                        if (result.error) {
                          if (!passkeyCancelled(result.error))
                            setError(
                              result.error.message ||
                                "Passkey sign-in failed. Try again or use your password.",
                            );
                        } else
                          onReady(
                            result.data as {
                              url?: string;
                              redirect_uri?: string;
                            },
                          );
                      })
                      .catch(() =>
                        setError(
                          "Passkey sign-in failed. Try again or use your password.",
                        ),
                      )
                      .finally(() => {
                        setBusy(false);
                        setPasskeyBusy(false);
                      });
                  }}
                >
                  {passkeyBusy ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <KeyRound size={16} />
                  )}{" "}
                  Sign in with a passkey
                </Button>
                <p className="field-hint">
                  {passkeysSupported
                    ? methods.password
                      ? "Or sign in with your password below."
                      : "Use your saved device, security key or password manager."
                    : "Passkeys need a supported browser and HTTPS or localhost."}
                </p>
              </div>
            )}
            {(setup || recovering || methods.password) && (
              <form onSubmit={submit} className="auth-form">
                {setup && setupStage === 0 && (
                  <div className="field">
                    <Label htmlFor="name">Your name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={80}
                      autoComplete="name"
                      placeholder="How should we call you?"
                    />
                  </div>
                )}
                {recovering ? (
                  <div className="field">
                    <Label htmlFor="recovery">Recovery code</Label>
                    <Input
                      id="recovery"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                      autoComplete="off"
                      placeholder="Your saved recovery code"
                    />
                  </div>
                ) : (
                  (!setup || setupStage === 0) && (
                    <div className="field">
                      <Label htmlFor="username">Username or email</Label>
                      <Input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        minLength={3}
                        maxLength={254}
                        autoCapitalize="none"
                        spellCheck={false}
                        autoComplete="username"
                        placeholder="Username or email address"
                      />
                      {setup && (
                        <p className="field-hint">
                          Use 3–30 letters, numbers, dots or underscores, or an
                          email address.
                        </p>
                      )}
                    </div>
                  )
                )}
                {setup && setupStage === 2 && (
                  <div className="field">
                    <label className="check-row">
                      <Checkbox
                        checked={encrypted}
                        disabled={installation?.locked || busy}
                        onCheckedChange={(v) => setEncrypted(v === true)}
                      />
                      Encrypt stored content
                    </label>
                    <p className="field-hint">
                      {installation?.locked
                        ? "Encryption was chosen when this installation initialized."
                        : "Enabled by default. This choice cannot change after setup."}
                    </p>
                    <p className="field-hint">
                      {encrypted
                        ? "Notes and files are encrypted on disk. Nivra decrypts them when you use the app."
                        : "Notes and files will be stored without encryption on disk. Account secrets and backups stay encrypted."}
                    </p>
                  </div>
                )}
                {setup && setupStage === 1 && (
                  <div className="setup-auth-method">
                    <Label>How would you like to sign in?</Label>
                    <div role="group" aria-label="Sign-in method">
                      <Button
                        type="button"
                        variant={
                          setupMethod === "password" ? "default" : "outline"
                        }
                        aria-pressed={setupMethod === "password"}
                        onClick={() => {
                          setSetupMethod("password");
                          setError("");
                        }}
                      >
                        Password
                      </Button>
                      <Button
                        type="button"
                        variant={
                          setupMethod === "passkey" ? "default" : "outline"
                        }
                        aria-pressed={setupMethod === "passkey"}
                        disabled={!passkeysSupported}
                        onClick={() => {
                          setSetupMethod("passkey");
                          setPassword("");
                          setConfirm("");
                          setError("");
                        }}
                      >
                        <KeyRound size={16} />
                        Passkey
                      </Button>
                    </div>
                    <p className="field-hint">
                      {setupMethod === "passkey"
                        ? "Use a device, security key or password manager. No password is required."
                        : "Use a password, with an optional authenticator for extra protection."}
                    </p>
                  </div>
                )}
                {(!setup ||
                  (setupStage === 1 && setupMethod === "password")) && (
                  <div className="field">
                    <Label htmlFor="password">
                      {recovering ? "New password" : "Password"}
                    </Label>
                    <div className="password-field">
                      <Input
                        id="password"
                        type={visible ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={setup || recovering ? 12 : undefined}
                        maxLength={128}
                        autoComplete={
                          setup || recovering
                            ? "new-password"
                            : "current-password"
                        }
                        placeholder={
                          setup || recovering
                            ? "At least 12 characters"
                            : "Enter your password"
                        }
                      />
                      <button
                        type="button"
                        aria-label={visible ? "Hide password" : "Show password"}
                        onClick={() => setVisible(!visible)}
                      >
                        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                  </div>
                )}
                {((setup && setupStage === 1 && setupMethod === "password") ||
                  recovering) && (
                  <div className="field">
                    <Label htmlFor="confirm">Confirm password</Label>
                    <Input
                      id="confirm"
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      required
                      autoComplete="new-password"
                      placeholder="Once more, to be sure"
                    />
                  </div>
                )}
                {(error || continuationError) && (
                  <p className="form-error" role="alert">
                    {error || continuationError}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <>
                      {setup
                        ? setupStage < 2
                          ? "Continue"
                          : setupMethod === "passkey"
                            ? "Create your passkey"
                            : "Create your space"
                        : recovering
                          ? "Reset password"
                          : "Sign in"}
                      <ArrowRight size={16} />
                    </>
                  )}
                </Button>
                {setup && setupStage > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setSetupStage(setupStage - 1);
                      setError("");
                    }}
                  >
                    <ArrowLeft size={16} /> Back
                  </Button>
                )}
              </form>
            )}
            {!setup && (
              <button
                className="text-button auth-secondary"
                onClick={() => {
                  setRecovering(!recovering);
                  setError("");
                  setPassword("");
                  setConfirm("");
                }}
              >
                {recovering ? (
                  <>
                    <ArrowLeft size={14} />
                    Back to sign in
                  </>
                ) : (
                  "Use recovery code"
                )}
              </button>
            )}
            {!methods.password && continuationError && (
              <p className="form-error" role="alert">
                {continuationError}
              </p>
            )}
          </>
        )}
        {step > 0 && error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
