import { sharedCapture } from "@/lib/capture";

export async function POST(request: Request) {
  const reader = request.body?.getReader();
  if (!reader)
    return new Response("No shared content was received.", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24_000) {
        await reader.cancel();
        return new Response(
          "Shared content is too large. Open Nivra and paste it instead.",
          { status: 413 },
        );
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((part) => Buffer.from(part)));
    const form = await new Request(request.url, {
      method: "POST",
      body,
      headers: {
        "content-type":
          request.headers.get("content-type") ||
          "application/x-www-form-urlencoded",
      },
    }).formData();
    const draft = sharedCapture(
      Object.fromEntries(
        ["title", "text", "url"].map((key) => [
          key,
          typeof form.get(key) === "string" ? (form.get(key) as string) : "",
        ]),
      ),
    );
    const target = new URL("/capture", request.url);
    target.hash = new URLSearchParams({
      title: draft.title,
      text: draft.text,
      url: draft.url,
    }).toString();
    return new Response(null, {
      status: 303,
      headers: {
        Location: target.pathname + target.hash,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return new Response(
      "This shared content could not be opened. Open Nivra and paste it instead.",
      {
        status: 400,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  } finally {
    reader.releaseLock();
  }
}
