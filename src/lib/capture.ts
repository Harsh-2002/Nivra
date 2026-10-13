import { z } from "./zod";

export const captureInput = z
  .object({
    type: z.enum(["note", "task", "bookmark"]),
    title: z.string().trim().max(300).default(""),
    text: z.string().max(10_000).default(""),
    url: z.string().max(4096).default(""),
    collection: z.string().trim().max(80).default(""),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "bookmark") {
      try {
        const url = new URL(value.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Enter a complete HTTP or HTTPS link without credentials.",
        });
      }
    } else if (value.type === "task" && !(value.title || value.text).trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message: "Enter a task.",
      });
    } else if (
      value.type === "task" &&
      (value.title || value.text).trim().length > 300
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message: "Use at most 300 characters for the task.",
      });
    } else if (value.type === "note" && !value.title && !value.text.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Add a title or some text.",
      });
    }
  });
export type CaptureDraft = z.infer<typeof captureInput>;
export const emptyCapture: CaptureDraft = {
  type: "bookmark",
  title: "",
  text: "",
  url: "",
  collection: "",
};

export function sharedCapture(fields: {
  title?: string;
  text?: string;
  url?: string;
}): CaptureDraft {
  let url = fields.url ?? "";
  let text = fields.text ?? "";
  if (!url && /^https?:\/\/\S+$/.test(text.trim())) {
    url = text.trim();
    text = "";
  }
  if (url && text.trim() === url.trim()) text = "";
  const draft = {
    ...emptyCapture,
    title: fields.title ?? "",
    text,
    url,
    type: url ? ("bookmark" as const) : ("note" as const),
  };
  return captureInput.parse(draft);
}

export function bookmarklet(origin: string) {
  const base = new URL(origin);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Use a complete HTTP or HTTPS origin without credentials.");
  const destination = new URL("/capture", base.origin).href;
  const literal = JSON.stringify(destination)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `javascript:(()=>{const p=new URLSearchParams({url:location.href,title:document.title.slice(0,300),text:String(getSelection()||'').slice(0,10000)});window.open(${literal}+'#'+p.toString(),'_blank','noopener,noreferrer')})()`;
}
