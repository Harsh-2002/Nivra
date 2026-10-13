DROP TRIGGER IF EXISTS bookmark_articles_ai;
DROP TRIGGER IF EXISTS bookmark_articles_ad;
DROP TRIGGER IF EXISTS bookmark_highlights_ai;
DROP TRIGGER IF EXISTS bookmark_highlights_ad;
DROP TRIGGER IF EXISTS bookmark_highlights_au;
DROP TRIGGER IF EXISTS bookmark_articles_semantic_insert;
DROP TRIGGER IF EXISTS bookmark_articles_semantic_delete;
DROP TRIGGER IF EXISTS bookmark_highlights_semantic_insert;
DROP TRIGGER IF EXISTS bookmark_highlights_semantic_update;
DROP TRIGGER IF EXISTS bookmark_highlights_semantic_delete;
DROP TRIGGER IF EXISTS bookmarks_article_trashed;

DROP TABLE IF EXISTS bookmark_articles_fts;
DROP TABLE IF EXISTS bookmark_highlights_fts;

DROP TRIGGER IF EXISTS bookmarks_jobs_delete;
CREATE TRIGGER bookmarks_jobs_delete AFTER DELETE ON bookmarks BEGIN
  DELETE FROM background_jobs WHERE kind='bookmark' AND target_id=old.id;
END;

UPDATE background_jobs
SET state='failed',lease_token=NULL,lease_until=NULL
WHERE kind='article' AND state IN ('queued','running');

UPDATE background_jobs
SET state='failed',lease_token=NULL,lease_until=NULL
WHERE kind='semantic'
  AND state IN ('queued','running')
  AND target_id IN (
    SELECT source_key FROM ai_content WHERE source_key LIKE 'bookmark:%'
  );

UPDATE ai_content
SET generation=generation+1,
    state='pending',
    pending=1,
    failures=0,
    retry_after=0,
    indexed_generation=NULL,
    fingerprint=NULL,
    model_version=NULL
WHERE source_key LIKE 'bookmark:%';
