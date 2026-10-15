export type PageTarget = { url: string; title: string };

export function savablePage(url?: string, title?: string): PageTarget | null {
  if (!url || url.length > 4096) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return { url: parsed.href, title: (title || "").trim().slice(0, 300) };
  } catch {
    return null;
  }
}
export function noteDocument(text: string, source?: string) {
  const paragraph = (value: string) => ({
    type: "paragraph",
    content: value ? [{ type: "text", text: value, styles: {} }] : [],
  });
  return {
    schemaVersion: 1,
    blocks: [
      ...text.split(/\n{2,}/).map((part) => paragraph(part.trim())),
      ...(source ? [paragraph(`Source: ${source}`)] : []),
    ],
  };
}

const sensitiveNames =
  /^(token|access_token|id_token|refresh_token|auth|authorization|key|api_key|apikey|secret|client_secret|password|passwd|sig|signature|session|sessionid|sid|otp|code|magic|reset)$/i;
const sensitivePath =
  /\/(reset-password|password-reset|magic-link|verify-email|confirm-email|oauth\/callback|auth\/callback)\b/i;
/** Addresses that probably carry a secret or single-use token in the query, hash or path. */
export function looksSensitive(url: string) {
  try {
    const parsed = new URL(url);
    const hash = new URLSearchParams(parsed.hash.replace(/^#\/?\??/, ""));
    return (
      sensitivePath.test(parsed.pathname) ||
      [...parsed.searchParams.keys(), ...hash.keys()].some((name) =>
        sensitiveNames.test(name),
      )
    );
  } catch {
    return false;
  }
}
