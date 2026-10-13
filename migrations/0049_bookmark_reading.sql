ALTER TABLE bookmarks ADD COLUMN read_at INTEGER;
ALTER TABLE bookmarks ADD COLUMN article_status TEXT NOT NULL DEFAULT 'unavailable' CHECK(article_status IN ('pending','ready','unavailable'));
ALTER TABLE bookmarks ADD COLUMN article_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN article_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE bookmark_articles (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  source_url TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  byline TEXT,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  plain_text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(bookmark_id, version)
);
CREATE INDEX bookmark_articles_owner_captured_idx ON bookmark_articles(owner_id, captured_at);
CREATE INDEX bookmark_articles_owner_fingerprint_idx ON bookmark_articles(owner_id, fingerprint);

CREATE TABLE bookmark_highlights (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL,
  article_version INTEGER NOT NULL,
  quote TEXT NOT NULL CHECK(length(quote) BETWEEN 1 AND 10000),
  prefix TEXT NOT NULL DEFAULT '' CHECK(length(prefix) <= 256),
  suffix TEXT NOT NULL DEFAULT '' CHECK(length(suffix) <= 256),
  start_offset INTEGER NOT NULL CHECK(start_offset BETWEEN 0 AND 200000),
  end_offset INTEGER NOT NULL CHECK(end_offset BETWEEN 1 AND 200000 AND end_offset > start_offset),
  annotation TEXT NOT NULL DEFAULT '' CHECK(length(annotation) <= 3000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(bookmark_id, article_version) REFERENCES bookmark_articles(bookmark_id, version) ON DELETE CASCADE
);
CREATE INDEX bookmark_highlights_owner_bookmark_idx ON bookmark_highlights(owner_id, bookmark_id);
CREATE INDEX bookmark_highlights_article_idx ON bookmark_highlights(bookmark_id, article_version);
CREATE TRIGGER bookmark_articles_owner_insert
BEFORE INSERT ON bookmark_articles
WHEN NOT EXISTS (
  SELECT 1 FROM bookmarks b WHERE b.id=NEW.bookmark_id AND b.owner_id=NEW.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Bookmark article must belong to its bookmark owner.'); END;
CREATE TRIGGER bookmark_articles_owner_update
BEFORE UPDATE OF bookmark_id,owner_id ON bookmark_articles
WHEN NOT EXISTS (
  SELECT 1 FROM bookmarks b WHERE b.id=NEW.bookmark_id AND b.owner_id=NEW.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Bookmark article must belong to its bookmark owner.'); END;
CREATE TRIGGER bookmark_highlights_owner_insert
BEFORE INSERT ON bookmark_highlights
WHEN NOT EXISTS (
  SELECT 1 FROM bookmark_articles a JOIN bookmarks b ON b.id=a.bookmark_id
  WHERE a.bookmark_id=NEW.bookmark_id AND a.version=NEW.article_version
    AND a.owner_id=NEW.owner_id AND b.owner_id=NEW.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Bookmark highlight must belong to its article owner.'); END;
CREATE TRIGGER bookmark_highlights_owner_update
BEFORE UPDATE OF owner_id,bookmark_id,article_version ON bookmark_highlights
WHEN NOT EXISTS (
  SELECT 1 FROM bookmark_articles a JOIN bookmarks b ON b.id=a.bookmark_id
  WHERE a.bookmark_id=NEW.bookmark_id AND a.version=NEW.article_version
    AND a.owner_id=NEW.owner_id AND b.owner_id=NEW.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Bookmark highlight must belong to its article owner.'); END;
CREATE TRIGGER bookmark_highlights_budget_insert
BEFORE INSERT ON bookmark_highlights
BEGIN
  SELECT CASE WHEN (
    SELECT count(*) FROM bookmark_highlights
    WHERE owner_id=NEW.owner_id AND bookmark_id=NEW.bookmark_id
  ) >= 1000 THEN RAISE(ABORT, 'bookmark_highlight_limit') END;
  SELECT CASE WHEN (
    SELECT coalesce(sum(length(CAST(quote AS BLOB)) + length(CAST(annotation AS BLOB))),0)
    FROM bookmark_highlights
    WHERE owner_id=NEW.owner_id AND bookmark_id=NEW.bookmark_id
  ) + length(CAST(NEW.quote AS BLOB)) + length(CAST(NEW.annotation AS BLOB)) > 200000
    THEN RAISE(ABORT, 'bookmark_highlight_text_limit') END;
END;
CREATE TRIGGER bookmark_highlights_budget_update
BEFORE UPDATE OF owner_id,bookmark_id,quote,annotation ON bookmark_highlights
BEGIN
  SELECT CASE WHEN (
    SELECT count(*) FROM bookmark_highlights
    WHERE owner_id=NEW.owner_id AND bookmark_id=NEW.bookmark_id AND id<>OLD.id
  ) >= 1000 THEN RAISE(ABORT, 'bookmark_highlight_limit') END;
  SELECT CASE WHEN (
    SELECT coalesce(sum(length(CAST(quote AS BLOB)) + length(CAST(annotation AS BLOB))),0)
    FROM bookmark_highlights
    WHERE owner_id=NEW.owner_id AND bookmark_id=NEW.bookmark_id AND id<>OLD.id
  ) + length(CAST(NEW.quote AS BLOB)) + length(CAST(NEW.annotation AS BLOB)) > 200000
    THEN RAISE(ABORT, 'bookmark_highlight_text_limit') END;
END;

CREATE VIRTUAL TABLE bookmark_articles_fts USING fts5(title, plain_text, content='bookmark_articles', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER bookmark_articles_ai AFTER INSERT ON bookmark_articles BEGIN
  INSERT INTO bookmark_articles_fts(rowid,title,plain_text) VALUES(new.rowid,new.title,new.plain_text);
END;
CREATE TRIGGER bookmark_articles_ad AFTER DELETE ON bookmark_articles BEGIN
  INSERT INTO bookmark_articles_fts(bookmark_articles_fts,rowid,title,plain_text) VALUES('delete',old.rowid,old.title,old.plain_text);
END;

CREATE VIRTUAL TABLE bookmark_highlights_fts USING fts5(quote, annotation, content='bookmark_highlights', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER bookmark_highlights_ai AFTER INSERT ON bookmark_highlights BEGIN
  INSERT INTO bookmark_highlights_fts(rowid,quote,annotation) VALUES(new.rowid,new.quote,new.annotation);
END;
CREATE TRIGGER bookmark_highlights_ad AFTER DELETE ON bookmark_highlights BEGIN
  INSERT INTO bookmark_highlights_fts(bookmark_highlights_fts,rowid,quote,annotation) VALUES('delete',old.rowid,old.quote,old.annotation);
END;
CREATE TRIGGER bookmark_highlights_au AFTER UPDATE ON bookmark_highlights BEGIN
  INSERT INTO bookmark_highlights_fts(bookmark_highlights_fts,rowid,quote,annotation) VALUES('delete',old.rowid,old.quote,old.annotation);
  INSERT INTO bookmark_highlights_fts(rowid,quote,annotation) VALUES(new.rowid,new.quote,new.annotation);
END;

DROP TRIGGER artifacts_jobs_delete;
DROP TRIGGER bookmarks_jobs_delete;
DROP TRIGGER form_files_jobs_delete;
DROP TRIGGER ai_content_jobs_delete;
ALTER TABLE background_jobs RENAME TO background_jobs_before_reading;
CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('artifact','bookmark','thumbnail','semantic','article')),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  created_at INTEGER NOT NULL,
  generation INTEGER,
  UNIQUE(kind,target_id)
);
INSERT INTO background_jobs SELECT * FROM background_jobs_before_reading;
DROP TABLE background_jobs_before_reading;
CREATE INDEX background_jobs_claim_idx ON background_jobs(state,available_at,lease_until);

CREATE TRIGGER artifacts_jobs_delete AFTER DELETE ON artifacts BEGIN
  DELETE FROM background_jobs WHERE kind IN ('artifact','thumbnail') AND target_id=old.id;
END;
CREATE TRIGGER bookmarks_jobs_delete AFTER DELETE ON bookmarks BEGIN
  DELETE FROM background_jobs WHERE kind IN ('bookmark','article') AND target_id=old.id;
END;
CREATE TRIGGER form_files_jobs_delete AFTER DELETE ON form_files BEGIN
  DELETE FROM background_jobs WHERE kind='thumbnail' AND target_id=old.id;
END;
CREATE TRIGGER ai_content_jobs_delete AFTER DELETE ON ai_content BEGIN
  DELETE FROM background_jobs WHERE kind='semantic' AND target_id=old.source_key;
END;

CREATE TRIGGER bookmarks_article_trashed AFTER UPDATE OF trashed_at ON bookmarks
WHEN NEW.trashed_at IS NOT NULL AND OLD.trashed_at IS NULL
BEGIN
  UPDATE background_jobs SET state='failed',lease_token=NULL,lease_until=NULL
    WHERE kind='article' AND target_id=NEW.id AND owner_id=NEW.owner_id;
  UPDATE bookmarks SET article_generation=article_generation+1,
    article_status=CASE WHEN article_status='pending' THEN 'unavailable' ELSE article_status END
    WHERE id=NEW.id AND owner_id=NEW.owner_id;
END;
