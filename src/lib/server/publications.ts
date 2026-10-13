import { apiNamespacePattern } from "../paths";
import { randomBytes, randomUUID } from "node:crypto";
import { sqlite } from "./db";
import { storage } from "./storage";
import { HttpError } from "./http";
import { plainText } from "./validation";
import type { Document, Note, Publication } from "../types";
import { publicationMedia } from "../media-url";
import { freezeTaskLinks } from "./writing-service";
import {
  renderPublicationHtml,
  publicationRendererVersion,
} from "./publication-html";

type PublicRow = Publication & { document: string; excerpt: string };
export function publicationFor(noteId: string): Publication | null {
  return (
    (sqlite()
      .prepare(
        "SELECT token,revision,published_at AS publishedAt FROM publications WHERE note_id=?",
      )
      .get(noteId) as Publication) || null
  );
}
export function publishedNote(token: string) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const row = sqlite()
    .prepare(
      "SELECT token,title,document,excerpt,revision,published_at AS publishedAt FROM publications WHERE token=?",
    )
    .get(token) as (PublicRow & { title: string }) | undefined;
  return row
    ? {
        ...row,
        document: publicationMedia(JSON.parse(row.document) as Document, token),
      }
    : null;
}
export async function revokePublication(noteId: string) {
  const published = publicationFor(noteId);
  if (!published) return;
  const files = sqlite()
    .prepare("SELECT storage_key FROM publication_files WHERE token=?")
    .all(published.token) as { storage_key: string }[];
  sqlite()
    .prepare("DELETE FROM publications WHERE token=?")
    .run(published.token);
  await Promise.all(files.map((file) => storage.delete(file.storage_key)));
}
export async function publishNote(note: Note, revision: number, owner: string) {
  if (note.trashedAt)
    throw new HttpError(400, "Restore this note before publishing it.");
  if (note.revision !== revision)
    throw new HttpError(409, "This note changed. Reload it before publishing.");
  const existing = publicationFor(note.id);
  const token = existing?.token || randomBytes(24).toString("hex");
  const oldFiles = sqlite()
    .prepare("SELECT storage_key FROM publication_files WHERE token=?")
    .all(token) as { storage_key: string }[];
  const attachments = sqlite()
    .prepare("SELECT id,name,mime,storage_key FROM attachments WHERE note_id=?")
    .all(note.id) as {
    id: string;
    name: string;
    mime: string;
    storage_key: string;
  }[];
  const references = new Set<string>();
  const collect = (value: unknown, key = "") => {
    if (Array.isArray(value)) return value.forEach((item) => collect(item));
    if (value && typeof value === "object")
      return Object.entries(value).forEach(([name, item]) =>
        collect(item, name),
      );
    if (typeof value === "string" && ["url", "href", "preview"].includes(key)) {
      const match = value.match(
        new RegExp(
          String.raw`^(?:https?://[^/]+)?/api/${apiNamespacePattern}/files/([a-f0-9-]{36})(?:[?#].*)?$`,
        ),
      );
      if (match) references.add(match[1]);
    }
  };
  collect(note.document);
  const copies: { id: string; name: string; mime: string; key: string }[] = [];
  const links = new Map<string, string>();
  try {
    for (const file of attachments.filter((file) => references.has(file.id))) {
      const id = randomUUID();
      await storage.write(id, await storage.read(file.storage_key));
      copies.push({ id, name: file.name, mime: file.mime, key: id });
      links.set(file.id, `/api/v1/published/${token}/files/${id}`);
    }
    const clean = (value: unknown, key = ""): unknown => {
      if (Array.isArray(value)) return value.map((item) => clean(item));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            clean(item, name),
          ]),
        );
      if (key === "scene") return "";
      if (
        typeof value === "string" &&
        ["url", "href", "preview"].includes(key)
      ) {
        const match = value.match(
          new RegExp(
            String.raw`^(?:https?://[^/]+)?/api/${apiNamespacePattern}/files/([a-f0-9-]{36})(?:[?#].*)?$`,
          ),
        );
        if (match) return links.get(match[1]) || "";
        if (value.startsWith("/api/")) return "";
        if (value && !/^(https?:\/\/|mailto:|#)/i.test(value)) return "";
      }
      return value;
    };
    const frozen = freezeTaskLinks(note.document, owner, note.id);
    const document = publicationMedia(clean(frozen) as Document, token);
    const now = Date.now();
    const excerpt = plainText(document.blocks).slice(0, 200);
    const html = await renderPublicationHtml(
      { title: note.title, document, publishedAt: now },
      excerpt,
      token,
    );
    sqlite()
      .transaction(() => {
        const current = sqlite()
          .prepare("SELECT revision,trashed_at FROM notes WHERE id=?")
          .get(note.id) as
          { revision: number; trashed_at: number | null } | undefined;
        if (!current || current.revision !== revision || current.trashed_at)
          throw new HttpError(409, "This note changed. Try publishing again.");
        sqlite()
          .prepare(
            "INSERT INTO publications VALUES(?,?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET title=excluded.title,document=excluded.document,excerpt=excluded.excerpt,revision=excluded.revision,published_at=excluded.published_at",
          )
          .run(
            token,
            note.id,
            note.title,
            JSON.stringify(document),
            excerpt,
            revision,
            now,
          );
        sqlite()
          .prepare(
            "INSERT INTO publication_pages(token,html,renderer_version) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET html=excluded.html,renderer_version=excluded.renderer_version",
          )
          .run(token, html, publicationRendererVersion());
        sqlite()
          .prepare("DELETE FROM publication_files WHERE token=?")
          .run(token);
        for (const file of copies)
          sqlite()
            .prepare("INSERT INTO publication_files VALUES(?,?,?,?,?)")
            .run(file.id, token, file.name, file.mime, file.key);
      })
      .immediate();
  } catch (error) {
    await Promise.all(copies.map((file) => storage.delete(file.key)));
    throw error;
  }
  await Promise.all(oldFiles.map((file) => storage.delete(file.storage_key)));
  return publicationFor(note.id)!;
}
