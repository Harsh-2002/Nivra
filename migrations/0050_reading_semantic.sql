CREATE TRIGGER bookmark_articles_semantic_insert AFTER INSERT ON bookmark_articles BEGIN
  INSERT INTO ai_content(source_key) VALUES('bookmark:'||new.bookmark_id)
  ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
END;
CREATE TRIGGER bookmark_articles_semantic_delete AFTER DELETE ON bookmark_articles
WHEN EXISTS(SELECT 1 FROM bookmarks WHERE id=old.bookmark_id) BEGIN
  INSERT INTO ai_content(source_key) VALUES('bookmark:'||old.bookmark_id)
  ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
END;
CREATE TRIGGER bookmark_highlights_semantic_insert AFTER INSERT ON bookmark_highlights BEGIN
  INSERT INTO ai_content(source_key) VALUES('bookmark:'||new.bookmark_id)
  ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
END;
CREATE TRIGGER bookmark_highlights_semantic_update AFTER UPDATE OF quote,annotation,article_version ON bookmark_highlights
WHEN old.quote IS NOT new.quote OR old.annotation IS NOT new.annotation OR old.article_version IS NOT new.article_version BEGIN
  INSERT INTO ai_content(source_key) VALUES('bookmark:'||new.bookmark_id)
  ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
END;
CREATE TRIGGER bookmark_highlights_semantic_delete AFTER DELETE ON bookmark_highlights
WHEN EXISTS(SELECT 1 FROM bookmarks WHERE id=old.bookmark_id) BEGIN
  INSERT INTO ai_content(source_key) VALUES('bookmark:'||old.bookmark_id)
  ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
END;
