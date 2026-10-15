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
