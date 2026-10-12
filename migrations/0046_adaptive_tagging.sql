ALTER TABLE ai_configuration ADD COLUMN tagging_mode TEXT NOT NULL DEFAULT 'manual' CHECK(tagging_mode IN('manual','automatic'));
ALTER TABLE ai_configuration ADD COLUMN learned_tag_revision INTEGER NOT NULL DEFAULT 1 CHECK(learned_tag_revision>0);
ALTER TABLE ai_configuration ADD COLUMN matcher_queue_revision INTEGER NOT NULL DEFAULT 1 CHECK(matcher_queue_revision>0);

CREATE TABLE ai_tag_revisions (
  tag_id TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX ai_content_canonical_item ON ai_content(owner_id,item_kind,item_id,source_key);
INSERT INTO ai_tag_revisions(tag_id) SELECT id FROM tags;
CREATE TRIGGER ai_tag_revision_insert AFTER INSERT ON tags BEGIN
  INSERT INTO ai_tag_revisions(tag_id,revision) VALUES(new.id,1);
END;
CREATE TRIGGER ai_tag_semantic_insert AFTER INSERT ON tags BEGIN
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_tag_semantic_update AFTER UPDATE OF name,aliases ON tags
WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_tag_semantic_delete AFTER DELETE ON tags BEGIN
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;

CREATE TABLE ai_tag_embeddings (
  tag_id TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  tag_fingerprint TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  aliases TEXT NOT NULL CHECK(json_valid(aliases) AND json_type(aliases)='array'),
  dimensions INTEGER NOT NULL DEFAULT 384 CHECK(dimensions=384),
  embedding BLOB NOT NULL CHECK(length(embedding)=1536),
  example_owner_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  learned_revision INTEGER NOT NULL DEFAULT 0 CHECK(learned_revision>=0),
  example_count INTEGER NOT NULL DEFAULT 0 CHECK(example_count>=0),
  example_embedding BLOB CHECK(example_embedding IS NULL OR length(example_embedding)=1536),
  updated_at INTEGER NOT NULL
);

CREATE TABLE ai_auto_assignments (
  source_key TEXT NOT NULL REFERENCES ai_content(source_key) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN(0,1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(source_key,tag_id)
);
CREATE INDEX ai_auto_assignments_tag ON ai_auto_assignments(tag_id,approved,source_key);

CREATE TABLE ai_tag_proposals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  name_fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pending','accepted','rejected','automatic')),
  cohesion REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  cooldown_until INTEGER,
  created_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  UNIQUE(owner_id,name_fingerprint)
);
CREATE INDEX ai_tag_proposals_owner_status ON ai_tag_proposals(owner_id,status,created_at);
CREATE INDEX ai_tag_proposals_daily_auto ON ai_tag_proposals(owner_id,status,reviewed_at) WHERE status='automatic';

CREATE TABLE ai_tag_proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES ai_tag_proposals(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL REFERENCES ai_content(source_key) ON DELETE CASCADE,
  canonical_item_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  model_version TEXT NOT NULL,
  terms TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(terms) AND json_type(terms)='array' AND json_array_length(terms)<=3),
  cohesion REAL NOT NULL DEFAULT 0,
  embedding BLOB NOT NULL CHECK(length(embedding)=1536),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(proposal_id,source_key),
  UNIQUE(proposal_id,canonical_item_key)
);
CREATE INDEX ai_tag_proposal_evidence_canonical ON ai_tag_proposal_evidence(proposal_id,canonical_item_key);

CREATE VIEW ai_source_tag_examples AS
  SELECT x.* FROM (
  SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id AS canonical_item_key,nt.tag_id
    FROM ai_content c JOIN notes n ON n.id=c.item_id AND n.owner_id=c.owner_id AND n.trashed_at IS NULL AND n.kind='note'
    JOIN note_tags nt ON nt.note_id=n.id
    WHERE c.item_kind='note' AND (
      c.source_key='note:'||c.item_id
      OR EXISTS(SELECT 1 FROM attachments a WHERE c.source_key='attachment:'||a.id AND a.note_id=n.id)
    )
  UNION ALL SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id,tt.tag_id
    FROM ai_content c JOIN tasks t ON t.id=c.item_id AND t.owner_id=c.owner_id AND t.trashed_at IS NULL
    JOIN task_tags tt ON tt.task_id=t.id
    WHERE c.item_kind='task' AND c.source_key='task:'||c.item_id
  UNION ALL SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id,bt.tag_id
    FROM ai_content c JOIN bookmarks b ON b.id=c.item_id AND b.owner_id=c.owner_id AND b.trashed_at IS NULL
    JOIN bookmark_tags bt ON bt.bookmark_id=b.id
    WHERE c.item_kind='bookmark' AND c.source_key='bookmark:'||c.item_id
  UNION ALL SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id,at.tag_id
    FROM ai_content c JOIN artifacts a ON a.id=c.item_id AND a.owner_id=c.owner_id AND a.trashed_at IS NULL
    JOIN artifact_tags at ON at.artifact_id=a.id
    WHERE c.item_kind='artifact' AND c.source_key='artifact:'||c.item_id
  UNION ALL SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id,et.tag_id
    FROM ai_content c JOIN calendar_events e ON e.id=c.item_id AND e.owner_id=c.owner_id AND e.trashed_at IS NULL
    JOIN event_tags et ON et.event_id=e.id
    WHERE c.item_kind='event' AND c.source_key='event:'||c.item_id
  UNION ALL SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id,ft.tag_id
    FROM ai_content c JOIN forms f ON f.id=c.item_id AND f.owner_id=c.owner_id AND f.trashed_at IS NULL
    JOIN form_tags ft ON ft.form_id=f.id
    WHERE c.item_kind='form' AND c.source_key='form:'||c.item_id
  UNION ALL SELECT c.source_key,c.owner_id,c.item_kind,c.item_id,c.item_kind||':'||c.item_id,rt.tag_id
    FROM ai_content c JOIN form_responses r ON r.id=c.item_id AND r.reviewed=1 AND r.trashed_at IS NULL
    JOIN forms f ON f.id=r.form_id AND f.owner_id=c.owner_id AND f.trashed_at IS NULL
    JOIN response_tags rt ON rt.response_id=r.id
    WHERE c.item_kind='response' AND (
      c.source_key='response:'||c.item_id
      OR EXISTS(SELECT 1 FROM form_files ff WHERE c.source_key='form-file:'||ff.id AND ff.response_id=r.id AND ff.form_id=f.id AND ff.state='attached')
    )
  ) x
  WHERE NOT EXISTS(
    SELECT 1 FROM ai_auto_assignments aa
    JOIN ai_content aut USING(source_key)
    WHERE aut.owner_id=x.owner_id AND aut.item_kind=x.item_kind AND aut.item_id=x.item_id
      AND aa.tag_id=x.tag_id AND aa.approved=0
  );

CREATE VIEW ai_current_tag_assignments AS
SELECT aa.source_key,aa.tag_id,aa.approved,c.owner_id,c.item_kind,c.item_id
FROM ai_auto_assignments aa
JOIN ai_content c USING(source_key)
WHERE aa.approved=1 OR (
  c.owner_id IS NOT NULL AND c.item_kind IS NOT NULL AND c.item_id IS NOT NULL
  AND c.state='indexed' AND c.indexed_generation=c.generation
  AND aa.generation=c.generation AND aa.fingerprint=c.fingerprint
  AND (
    (c.item_kind='note' AND c.source_key='note:'||c.item_id AND EXISTS(SELECT 1 FROM notes n WHERE n.id=c.item_id AND n.owner_id=c.owner_id AND n.kind='note' AND n.trashed_at IS NULL))
    OR (c.item_kind='note' AND c.source_key LIKE 'attachment:%' AND EXISTS(SELECT 1 FROM notes n WHERE n.id=c.item_id AND n.owner_id=c.owner_id AND n.kind='note' AND n.trashed_at IS NULL) AND EXISTS(SELECT 1 FROM attachments a WHERE c.source_key='attachment:'||a.id AND a.note_id=c.item_id))
    OR (c.item_kind='task' AND c.source_key='task:'||c.item_id AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=c.item_id AND t.owner_id=c.owner_id AND t.trashed_at IS NULL))
    OR (c.item_kind='bookmark' AND c.source_key='bookmark:'||c.item_id AND EXISTS(SELECT 1 FROM bookmarks b WHERE b.id=c.item_id AND b.owner_id=c.owner_id AND b.trashed_at IS NULL))
    OR (c.item_kind='artifact' AND c.source_key='artifact:'||c.item_id AND EXISTS(SELECT 1 FROM artifacts a WHERE a.id=c.item_id AND a.owner_id=c.owner_id AND a.trashed_at IS NULL))
    OR (c.item_kind='event' AND c.source_key='event:'||c.item_id AND EXISTS(SELECT 1 FROM calendar_events e WHERE e.id=c.item_id AND e.owner_id=c.owner_id AND e.trashed_at IS NULL))
    OR (c.item_kind='form' AND c.source_key='form:'||c.item_id AND EXISTS(SELECT 1 FROM forms f WHERE f.id=c.item_id AND f.owner_id=c.owner_id AND f.trashed_at IS NULL))
    OR (c.item_kind='response' AND EXISTS(
      SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id
      WHERE r.id=c.item_id AND r.reviewed=1 AND r.trashed_at IS NULL AND f.owner_id=c.owner_id AND f.trashed_at IS NULL
        AND (c.source_key='response:'||r.id OR EXISTS(SELECT 1 FROM form_files ff WHERE c.source_key='form-file:'||ff.id AND ff.response_id=r.id AND ff.form_id=f.id AND ff.state='attached'))
    ))
  )
);

CREATE TRIGGER ai_auto_assignment_source_generation AFTER UPDATE OF generation ON ai_content
WHEN old.generation IS NOT new.generation
BEGIN
  DELETE FROM ai_auto_assignments WHERE source_key=new.source_key AND approved=0;
END;

CREATE TRIGGER ai_auto_assignment_source_delete BEFORE DELETE ON ai_content
BEGIN
  DELETE FROM ai_auto_assignments WHERE source_key=old.source_key AND approved=0;
END;

CREATE TRIGGER ai_auto_assignment_cleanup AFTER DELETE ON ai_auto_assignments
WHEN old.approved=0
  AND EXISTS(SELECT 1 FROM ai_content WHERE source_key=old.source_key)
  AND EXISTS(SELECT 1 FROM tags WHERE id=old.tag_id)
BEGIN
  DELETE FROM note_tags WHERE tag_id=old.tag_id
    AND note_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='note')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='note' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE notes SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='note') AND changes()>0;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'changed',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='note' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;

  DELETE FROM task_tags WHERE tag_id=old.tag_id
    AND task_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='task')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='task' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE tasks SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='task') AND changes()>0;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'changed',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='task' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;

  DELETE FROM bookmark_tags WHERE tag_id=old.tag_id
    AND bookmark_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='bookmark')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='bookmark' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE bookmarks SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='bookmark') AND changes()>0;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'changed',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='bookmark' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;

  DELETE FROM artifact_tags WHERE tag_id=old.tag_id
    AND artifact_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='artifact')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='artifact' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE artifacts SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='artifact') AND changes()>0;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'changed',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='artifact' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;

  DELETE FROM event_tags WHERE tag_id=old.tag_id
    AND event_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='event')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='event' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE calendar_events SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='event') AND changes()>0;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'changed',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='event' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;

  DELETE FROM form_tags WHERE tag_id=old.tag_id
    AND form_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='form')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='form' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE forms SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='form') AND changes()>0;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'forms',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='form' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;

  DELETE FROM response_tags WHERE tag_id=old.tag_id
    AND response_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='response')
    AND NOT EXISTS(SELECT 1 FROM ai_current_tag_assignments a
      WHERE a.owner_id=(SELECT owner_id FROM ai_content WHERE source_key=old.source_key)
        AND a.item_kind='response' AND a.item_id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key)
        AND a.tag_id=old.tag_id);
  UPDATE form_responses SET revision=revision+1 WHERE id=(SELECT item_id FROM ai_content WHERE source_key=old.source_key AND item_kind='response') AND changes()>0 AND reviewed=1;
  INSERT INTO completion_events(owner_id,kind,target_id,status,created_at)
    SELECT owner_id,'content',item_id,'changed',CAST(strftime('%s','now') AS INTEGER)*1000 FROM ai_content WHERE source_key=old.source_key AND item_kind='response' AND changes()>0;
  DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events) AND changes()>0;
END;

CREATE TRIGGER ai_tag_example_generation AFTER UPDATE OF generation ON ai_content
WHEN old.generation IS NOT new.generation
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1
  WHERE tag_id IN (
    SELECT tag_id FROM note_tags WHERE new.item_kind='note' AND note_id=new.item_id
    UNION ALL SELECT tag_id FROM task_tags WHERE new.item_kind='task' AND task_id=new.item_id
    UNION ALL SELECT tag_id FROM bookmark_tags WHERE new.item_kind='bookmark' AND bookmark_id=new.item_id
    UNION ALL SELECT tag_id FROM artifact_tags WHERE new.item_kind='artifact' AND artifact_id=new.item_id
    UNION ALL SELECT tag_id FROM event_tags WHERE new.item_kind='event' AND event_id=new.item_id
    UNION ALL SELECT tag_id FROM form_tags WHERE new.item_kind='form' AND form_id=new.item_id
    UNION ALL SELECT tag_id FROM response_tags WHERE new.item_kind='response' AND response_id=new.item_id
  );
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1
  WHERE id=1 AND EXISTS (
    SELECT 1 FROM note_tags WHERE new.item_kind='note' AND note_id=new.item_id
    UNION ALL SELECT 1 FROM task_tags WHERE new.item_kind='task' AND task_id=new.item_id
    UNION ALL SELECT 1 FROM bookmark_tags WHERE new.item_kind='bookmark' AND bookmark_id=new.item_id
    UNION ALL SELECT 1 FROM artifact_tags WHERE new.item_kind='artifact' AND artifact_id=new.item_id
    UNION ALL SELECT 1 FROM event_tags WHERE new.item_kind='event' AND event_id=new.item_id
    UNION ALL SELECT 1 FROM form_tags WHERE new.item_kind='form' AND form_id=new.item_id
    UNION ALL SELECT 1 FROM response_tags WHERE new.item_kind='response' AND response_id=new.item_id
  );
END;

CREATE TRIGGER ai_tag_example_indexed AFTER UPDATE OF state,indexed_generation,fingerprint ON ai_content
WHEN new.state='indexed' AND (old.indexed_generation IS NOT new.indexed_generation OR old.fingerprint IS NOT new.fingerprint)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1
  WHERE tag_id IN (
    SELECT tag_id FROM note_tags WHERE new.item_kind='note' AND note_id=new.item_id
    UNION ALL SELECT tag_id FROM task_tags WHERE new.item_kind='task' AND task_id=new.item_id
    UNION ALL SELECT tag_id FROM bookmark_tags WHERE new.item_kind='bookmark' AND bookmark_id=new.item_id
    UNION ALL SELECT tag_id FROM artifact_tags WHERE new.item_kind='artifact' AND artifact_id=new.item_id
    UNION ALL SELECT tag_id FROM event_tags WHERE new.item_kind='event' AND event_id=new.item_id
    UNION ALL SELECT tag_id FROM form_tags WHERE new.item_kind='form' AND form_id=new.item_id
    UNION ALL SELECT tag_id FROM response_tags WHERE new.item_kind='response' AND response_id=new.item_id
  );
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1
  WHERE id=1 AND EXISTS (
    SELECT 1 FROM note_tags WHERE new.item_kind='note' AND note_id=new.item_id
    UNION ALL SELECT 1 FROM task_tags WHERE new.item_kind='task' AND task_id=new.item_id
    UNION ALL SELECT 1 FROM bookmark_tags WHERE new.item_kind='bookmark' AND bookmark_id=new.item_id
    UNION ALL SELECT 1 FROM artifact_tags WHERE new.item_kind='artifact' AND artifact_id=new.item_id
    UNION ALL SELECT 1 FROM event_tags WHERE new.item_kind='event' AND event_id=new.item_id
    UNION ALL SELECT 1 FROM form_tags WHERE new.item_kind='form' AND form_id=new.item_id
    UNION ALL SELECT 1 FROM response_tags WHERE new.item_kind='response' AND response_id=new.item_id
  );
END;

CREATE TRIGGER ai_note_tag_example_insert AFTER INSERT ON note_tags
WHEN NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='note' AND s.item_id=new.note_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_note_tag_example_delete AFTER DELETE ON note_tags
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_task_tag_example_insert AFTER INSERT ON task_tags
WHEN NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='task' AND s.item_id=new.task_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_task_tag_example_delete AFTER DELETE ON task_tags
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_bookmark_tag_example_insert AFTER INSERT ON bookmark_tags
WHEN NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='bookmark' AND s.item_id=new.bookmark_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_bookmark_tag_example_delete AFTER DELETE ON bookmark_tags
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_artifact_tag_example_insert AFTER INSERT ON artifact_tags
WHEN NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='artifact' AND s.item_id=new.artifact_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_artifact_tag_example_delete AFTER DELETE ON artifact_tags
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_event_tag_example_insert AFTER INSERT ON event_tags
WHEN NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='event' AND s.item_id=new.event_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_event_tag_example_delete AFTER DELETE ON event_tags
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_form_tag_example_insert AFTER INSERT ON form_tags
WHEN NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='form' AND s.item_id=new.form_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_form_tag_example_delete AFTER DELETE ON form_tags
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_response_tag_example_insert AFTER INSERT ON response_tags
WHEN EXISTS(SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=new.response_id AND r.reviewed=1 AND f.trashed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_content s USING(source_key) WHERE s.item_kind='response' AND s.item_id=new.response_id AND aa.tag_id=new.tag_id AND aa.approved=0)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_response_tag_example_delete AFTER DELETE ON response_tags
WHEN EXISTS(SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=old.response_id AND r.reviewed=1 AND f.trashed_at IS NULL)
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=old.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;
CREATE TRIGGER ai_auto_tag_approved AFTER UPDATE OF approved ON ai_auto_assignments
WHEN old.approved=0 AND new.approved=1
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1 WHERE tag_id=new.tag_id;
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1;
END;

CREATE TRIGGER ai_reviewed_response_examples AFTER UPDATE OF reviewed ON form_responses
WHEN old.reviewed IS NOT new.reviewed
BEGIN
  UPDATE ai_tag_revisions SET revision=revision+1
  WHERE tag_id IN (
    SELECT rt.tag_id FROM response_tags rt
    WHERE rt.response_id=new.id AND NOT EXISTS(
      SELECT 1 FROM ai_auto_assignments aa JOIN ai_content aut USING(source_key)
      WHERE aut.owner_id=(SELECT f.owner_id FROM forms f JOIN form_responses r ON r.form_id=f.id WHERE r.id=new.id)
        AND aut.item_kind='response' AND aut.item_id=new.id AND aa.tag_id=rt.tag_id AND aa.approved=0
    )
  );
  UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1
  WHERE id=1 AND EXISTS(
    SELECT 1 FROM response_tags rt WHERE rt.response_id=new.id AND NOT EXISTS(
      SELECT 1 FROM ai_auto_assignments aa JOIN ai_content aut USING(source_key)
      WHERE aut.item_kind='response' AND aut.item_id=new.id AND aa.tag_id=rt.tag_id AND aa.approved=0
    )
  );
  UPDATE ai_content SET pending=1,failures=0,retry_after=0
  WHERE source_key='response:'||new.id
     OR source_key IN (SELECT 'form-file:'||id FROM form_files WHERE response_id=new.id);
  DELETE FROM ai_auto_assignments
  WHERE approved=0 AND new.reviewed=0 AND (
    source_key='response:'||new.id
    OR source_key IN (SELECT 'form-file:'||id FROM form_files WHERE response_id=new.id)
  );
END;

UPDATE ai_content SET pending=1,failures=0,retry_after=0;
UPDATE ai_configuration SET matcher_queue_revision=learned_tag_revision WHERE id=1;

-- Current-fingerprint corrections are unbounded; obsolete history is 180 days and 128 rows per source.
DELETE FROM ai_decisions
WHERE fingerprint IS NOT (
  SELECT fingerprint FROM ai_content WHERE source_key=ai_decisions.source_key
)
AND created_at < CAST(strftime('%s','now') AS INTEGER)*1000 - 15552000000;
DELETE FROM ai_decisions
WHERE rowid IN (
  SELECT rowid FROM (
    SELECT d.rowid,
           row_number() OVER(PARTITION BY d.source_key ORDER BY d.created_at DESC,d.rowid DESC) AS obsolete_rank
    FROM ai_decisions d
    WHERE d.fingerprint IS NOT (
      SELECT fingerprint FROM ai_content WHERE source_key=d.source_key
    )
  )
  WHERE obsolete_rank>128
);

CREATE TRIGGER ai_decision_retention_insert AFTER INSERT ON ai_decisions BEGIN
  DELETE FROM ai_decisions
  WHERE source_key=new.source_key
    AND fingerprint IS NOT (
      SELECT fingerprint FROM ai_content WHERE source_key=new.source_key
    )
    AND created_at < CAST(strftime('%s','now') AS INTEGER)*1000 - 15552000000;
  DELETE FROM ai_decisions
  WHERE rowid IN (
    SELECT rowid FROM ai_decisions
    WHERE source_key=new.source_key
      AND fingerprint IS NOT (
        SELECT fingerprint FROM ai_content WHERE source_key=new.source_key
      )
    ORDER BY created_at DESC,rowid DESC
    LIMIT -1 OFFSET 128
  );
END;

CREATE TRIGGER ai_decision_retention_fingerprint AFTER UPDATE OF fingerprint ON ai_content
WHEN old.fingerprint IS NOT new.fingerprint BEGIN
  DELETE FROM ai_decisions
  WHERE source_key=new.source_key
    AND fingerprint IS NOT new.fingerprint
    AND created_at < CAST(strftime('%s','now') AS INTEGER)*1000 - 15552000000;
  DELETE FROM ai_decisions
  WHERE rowid IN (
    SELECT rowid FROM ai_decisions
    WHERE source_key=new.source_key
      AND fingerprint IS NOT new.fingerprint
    ORDER BY created_at DESC,rowid DESC
    LIMIT -1 OFFSET 128
  );
END;
