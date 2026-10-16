"use client";
import { useEffect, useState } from "react";
import { KeyRound, Loader2, Plus } from "lucide-react";
import {
  passkeyAuth,
  usePasskeySupported,
  passkeyCancelled,
} from "@/lib/passkey-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useConfirm } from "./confirm-provider";
import { formatDay } from "@/lib/dates";

type Credential = {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
};
export function PasskeySettings({
  hasPassword,
  onGuardChange,
  onSignOut,
}: {
  hasPassword: boolean;
  onGuardChange: (blocked: boolean) => void;
  onSignOut: () => Promise<void>;
}) {
  const [items, setItems] = useState<Credential[] | null>(null);
  const supported = usePasskeySupported();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const confirm = useConfirm();
  useEffect(() => {
    let active = true;
    void passkeyAuth.passkey
      .listUserPasskeys()
      .then((result) => {
        if (!active) return;
        if (result.error)
          setError(result.error.message || "Passkeys could not be loaded.");
        else setItems(result.data || []);
      })
      .catch(() => {
        if (active)
          setError(
            "Passkeys could not be loaded. Check your connection and try again.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onGuardChange(busy);
    return () => onGuardChange(false);
  }, [busy, onGuardChange]);
  async function load() {
    const result = await passkeyAuth.passkey.listUserPasskeys();
    if (result.error)
      throw new Error(result.error.message || "Passkeys could not be loaded.");
    setItems(result.data || []);
  }
  async function run(
    action: () => Promise<{
      error: { code?: string; message?: string } | null;
    }>,
  ) {
    setBusy(true);
    setError("");
    setReauth(false);
    try {
      const result = await action();
      if (result.error) {
        if (
          result.error.code === "PASSKEY_REAUTH_REQUIRED" ||
          result.error.code === "SESSION_NOT_FRESH"
        )
          setReauth(true);
        else if (!passkeyCancelled(result.error))
          setError(
            result.error.message ||
              "This passkey action could not be completed.",
          );
        return;
      }
      setEditing(null);
      setName("");
      await load();
    } catch {
      setError(
        "Passkeys could not be updated. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="passkey-settings">
      <h2>Passkeys</h2>
      {!hasPassword && items?.length === 1 && (
        <p className="field-hint">
          Add a password or another passkey before removing your last passkey.
        </p>
      )}
      <p className="settings-description">
        Sign in with a security key, your device or a password manager. A PIN or
        biometrics verifies it’s you.
      </p>
      {!supported && (
        <p className="field-hint">
          Passkeys need a supported browser and HTTPS or localhost. You can
          still sign in with your password.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {reauth && (
        <div className="passkey-reauth">
          <p role="status">
            For security, sign in again before managing passkeys.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void onSignOut()}
          >
            Sign in again
          </Button>
        </div>
      )}
      {items === null ? (
        <p role="status">
          {error ? (
            <Button
              variant="outline"
              onClick={() =>
                void run(async () => {
                  await load();
                  return { error: null };
                })
              }
            >
              Try again
            </Button>
          ) : (
            "Loading passkeys…"
          )}
        </p>
      ) : items.length ? (
        <ul className="passkey-list">
          {items.map((item) => (
            <li key={item.id}>
              <div className="passkey-heading">
                <KeyRound size={18} />
                <div>
                  <strong>{item.name || "Passkey"}</strong>
                  {item.createdAt && (
                    <p className="field-hint">
                      Added {formatDay(item.createdAt)}
                    </p>
                  )}
                </div>
              </div>
              {editing === item.id ? (
                <form
                  className="passkey-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() =>
                      passkeyAuth.passkey.updatePasskey({
                        id: item.id,
                        name: name.trim(),
                      }),
                    );
                  }}
                >
                  <Label htmlFor="passkey-name">Passkey name</Label>
                  <Input
                    id="passkey-name"
                    value={name}
                    autoFocus
                    required
                    maxLength={80}
                    disabled={busy}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <div className="passkey-actions">
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={busy || !name.trim()}
                    >
                      Save name
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="passkey-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || reauth}
                    onClick={() => {
                      setEditing(item.id);
                      setName(item.name || "Passkey");
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      busy || reauth || (!hasPassword && items.length <= 1)
                    }
                    onClick={() =>
                      void run(async () => {
                        if (
                          !(await confirm({
                            title: "Remove this passkey?",
                            description: `${item.name || "This passkey"} will no longer sign in to Nivra. Your password and other passkeys will still work.`,
                            action: "Remove passkey",
                          }))
                        )
                          return { error: null };
                        return passkeyAuth.passkey.deletePasskey({
                          id: item.id,
                        });
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-description">
          No passkeys yet. Add one to make signing in easier.
        </p>
      )}
      <Button
        variant="outline"
        disabled={!supported || busy || reauth || items === null}
        onClick={() =>
          void run(() => passkeyAuth.passkey.addPasskey({ name: "Passkey" }))
        }
      >
        {busy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Plus size={16} />
        )}{" "}
        Add passkey
      </Button>
      <p className="field-hint">
        You can add more than one. Account recovery keeps your registered
        passkeys.
      </p>
    </div>
  );
}
