"use client";
import type { Document } from "@/lib/types";
import { readingBlocks } from "@/lib/reader";
import { NoteContent } from "./note-content";
import { useCspNonce } from "@/lib/csp";
import { readerStyles } from "@/lib/reader-styles";

export function NoteReading({
  title,
  document,
}: {
  title: string;
  document: Document;
}) {
  const nonce = useCspNonce();
  const styles = readerStyles(document);
  return (
    <article className="note-reading">
      {styles && <style nonce={nonce}>{styles}</style>}
      <h1>{title || "Untitled"}</h1>
      <NoteContent blocks={readingBlocks(title, document)} />
    </article>
  );
}
export function PublishedReader({
  title,
  document,
  publishedAt,
}: {
  title: string;
  document: Document;
  publishedAt: number;
}) {
  return (
    <main className="publication-page" tabIndex={0}>
      <header className="publication-header">
        <span>Shared note</span>
        <time dateTime={new Date(publishedAt).toISOString()}>
          {new Date(publishedAt).toLocaleDateString("en", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          })}
        </time>
      </header>
      <NoteReading title={title} document={document} />
    </main>
  );
}
