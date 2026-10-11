DROP TRIGGER artifacts_jobs_delete;
DROP TRIGGER bookmarks_jobs_delete;
DROP TRIGGER form_files_jobs_delete;
CREATE TABLE background_jobs_new (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('artifact','bookmark','thumbnail','semantic')),
 target_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','done','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,created_at INTEGER NOT NULL,UNIQUE(kind,target_id)
);
INSERT INTO background_jobs_new SELECT * FROM background_jobs;
DROP TABLE background_jobs;
ALTER TABLE background_jobs_new RENAME TO background_jobs;
ALTER TABLE background_jobs ADD COLUMN generation INTEGER;
CREATE INDEX background_jobs_claim_idx ON background_jobs(state,available_at,lease_until);
CREATE TRIGGER artifacts_jobs_delete AFTER DELETE ON artifacts BEGIN DELETE FROM background_jobs WHERE kind IN('artifact','thumbnail') AND target_id=old.id; END;
CREATE TRIGGER bookmarks_jobs_delete AFTER DELETE ON bookmarks BEGIN DELETE FROM background_jobs WHERE kind='bookmark' AND target_id=old.id; END;
CREATE TRIGGER form_files_jobs_delete AFTER DELETE ON form_files BEGIN DELETE FROM background_jobs WHERE kind='thumbnail' AND target_id=old.id; END;
CREATE TRIGGER ai_content_jobs_delete AFTER DELETE ON ai_content BEGIN DELETE FROM background_jobs WHERE kind='semantic' AND target_id=old.source_key; END;
ALTER TABLE completion_events RENAME TO previous_completion_events;
CREATE TABLE completion_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('artifact','bookmark','backup','content','ai')),target_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL
);
INSERT INTO completion_events SELECT * FROM previous_completion_events;
DROP TABLE previous_completion_events;
CREATE INDEX completion_events_owner_idx ON completion_events(owner_id,id);
