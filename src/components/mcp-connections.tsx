"use client";
import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, Unplug } from "lucide-react";
import { api } from "@/lib/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { McpClientSetup } from "./mcp-client-setup";
import { useConfirm } from "./confirm-provider";
import { formatDay } from "@/lib/dates";
type Connections = {
  endpoint: string;
  keys: {
    id: string;
    name: string;
    start: string;
    permissions: string;
    expiresAt: number | null;
    lastUsed: number | null;
  }[];
  connections: { clientId: string; name: string | null }[];
};
export function McpConnections({
  onGuardChange,
}: {
  onGuardChange: (busy: boolean) => void;
}) {
  const [data, setData] = useState<Connections | null>(null);
  const [name, setName] = useState("");
  const [full, setFull] = useState(false);
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [secretId, setSecretId] = useState("");
  const [copied, setCopied] = useState("");
  const [keyForm, setKeyForm] = useState(false);
  const confirm = useConfirm();
  const load = () => api<Connections>("ai-connections").then(setData);
  useEffect(() => {
    let active = true;
    api<Connections>("ai-connections")
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onGuardChange(busy);
    return () => onGuardChange(false);
  }, [busy, onGuardChange]);
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ key?: string; id?: string }>(
        "ai-connections",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      if (result.key) {
        setSecret(result.key);
        setSecretId(result.id || "");
      } else if (body.action === "revoke-key" && body.id === secretId) {
        setSecret("");
        setSecretId("");
      }
      setCopied("");
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setError("Copy is unavailable. Select and copy the value below.");
    }
  }
  if (!data)
    return <p role={error ? "alert" : "status"}>{error || "Loading MCP…"}</p>;
  return (
    <div className="ai-connections">
      <div className="settings-section-heading">
        <h2>MCP</h2>
        <p>Connect a client to your workspace.</p>
      </div>
      <div className="field">
        <Label htmlFor="mcp-endpoint">MCP endpoint</Label>
        <div className="ai-copy-row">
          <Input id="mcp-endpoint" value={data.endpoint} readOnly />
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy MCP endpoint"
            onClick={() => void copy(data.endpoint)}
          >
            {copied === data.endpoint ? (
              <Check size={16} />
            ) : (
              <Copy size={16} />
            )}
          </Button>
        </div>
      </div>
      <McpClientSetup
        endpoint={data.endpoint}
        copy={copy}
        copied={copied}
        credential={secret}
        busy={busy}
        onCreateKey={(clientName) => {
          setName(clientName);
          setFull(false);
          setExpires("");
          setKeyForm(true);
        }}
      />
      {secret && (
        <section className="ai-secret" aria-label="New credential">
          <h3>Save this credential</h3>
          <p>It is only shown once. Keep it private.</p>
          <pre tabIndex={0}>{secret}</pre>
          <div className="ai-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy(secret)}
            >
              <Copy size={14} />
              {copied === secret ? "Copied" : "Copy credential"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSecret("");
                setSecretId("");
                setCopied("");
              }}
            >
              Done
            </Button>
          </div>
        </section>
      )}
      <section>
        <div className="mcp-section-title">
          <h3>API keys</h3>
          {!keyForm && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !!secret}
              onClick={() => {
                setKeyForm(true);
                setFull(false);
                setExpires("");
              }}
            >
              <Plus size={14} />
              New key
            </Button>
          )}
        </div>
        {keyForm && (
          <form
            className="ai-key-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run({
                  action: "create-key",
                  name,
                  access: full ? "full" : "read",
                  ...(expires ? { expiresIn: Number(expires) * 86400 } : {}),
                })
              ) {
                setName("");
                setKeyForm(false);
              }
            }}
          >
            <div className="field">
              <Label htmlFor="agent-key-name">Name</Label>
              <Input
                id="agent-key-name"
                autoFocus
                placeholder="e.g. My client"
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="field">
              <Label htmlFor="agent-key-expiry">
                Expires after <span className="field-hint">(days)</span>
              </Label>
              <Input
                id="agent-key-expiry"
                type="number"
                min={1}
                max={365}
                placeholder="e.g. 60"
                aria-describedby="agent-key-expiry-hint"
                inputMode="numeric"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                disabled={busy}
              />
            </div>
            <p id="agent-key-expiry-hint" className="field-hint">
              Leave blank for no expiry.
            </p>
            <div className="field">
              <span id="agent-key-access-label">Access</span>
              <div
                className="ai-actions"
                role="group"
                aria-labelledby="agent-key-access-label"
              >
                <Button
                  type="button"
                  variant={full ? "outline" : "default"}
                  aria-pressed={!full}
                  disabled={busy}
                  onClick={() => setFull(false)}
                >
                  Read
                </Button>
                <Button
                  type="button"
                  variant={full ? "default" : "outline"}
                  aria-pressed={full}
                  disabled={busy}
                  onClick={() => setFull(true)}
                >
                  Read &amp; write
                </Button>
              </div>
              <p className="field-hint">
                {full
                  ? "Read, create, edit, publish, and move items to Trash."
                  : "Search and read content. No changes allowed."}
              </p>
            </div>
            <p className="field-hint">
              Trash is read-only for agents. Only you can restore or permanently
              delete items.
            </p>
            <div className="ai-actions">
              <Button type="submit" disabled={busy || !name.trim() || !!secret}>
                {busy ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Plus size={15} />
                )}
                Create key
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setKeyForm(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {!data.keys.length ? (
          <p className="field-hint">No API keys yet.</p>
        ) : (
          <ul className="ai-connection-list">
            {data.keys.map((key) => (
              <li key={key.id}>
                <div>
                  <strong>{key.name || "API key"}</strong>
                  <small>
                    {key.start}… ·{" "}
                    {key.permissions?.includes("write")
                      ? "Read & write"
                      : "Read"}
                    {key.expiresAt
                      ? ` · Expires ${formatDay(key.expiresAt)}`
                      : ""}
                  </small>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Revoke this API key?",
                        description: "The agent will lose access immediately.",
                        action: "Revoke key",
                      })
                    )
                      void run({ action: "revoke-key", id: key.id });
                  }}
                >
                  <Unplug size={14} />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Connected clients</h3>
        {!data.connections.length ? (
          <p className="field-hint">No connected clients.</p>
        ) : (
          <ul className="ai-connection-list">
            {data.connections.map((client) => (
              <li key={client.clientId}>
                <div>
                  <strong>{client.name || "Client"}</strong>
                  <small>OAuth</small>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Disconnect this client?",
                        description:
                          "Its existing tokens will stop working immediately. It can reconnect with your consent.",
                        action: "Disconnect",
                      })
                    )
                      void run({
                        action: "revoke-oauth",
                        clientId: client.clientId,
                      });
                  }}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!!copied && (
        <p role="status" className="sr-only">
          Copied.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
