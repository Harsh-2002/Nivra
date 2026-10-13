ALTER TABLE tasks ADD COLUMN schedule_start_local TEXT;
ALTER TABLE tasks ADD COLUMN schedule_timezone TEXT;
ALTER TABLE tasks ADD COLUMN schedule_duration_minutes INTEGER
  CHECK(schedule_duration_minutes IS NULL OR schedule_duration_minutes BETWEEN 5 AND 1440);
ALTER TABLE tasks ADD COLUMN schedule_disambiguation TEXT
  CHECK(schedule_disambiguation IS NULL OR schedule_disambiguation IN('earlier','later','reject'));
ALTER TABLE tasks ADD COLUMN schedule_issue TEXT
  CHECK(schedule_issue IS NULL OR schedule_issue='needs-scheduling');
ALTER TABLE tasks ADD COLUMN recurrence_rule_json TEXT
  CHECK(recurrence_rule_json IS NULL OR json_valid(recurrence_rule_json));

CREATE INDEX tasks_owner_schedule_idx ON tasks(owner_id,schedule_start_local);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 300),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX task_steps_owner_task_position_idx ON task_steps(owner_id,task_id,position);

CREATE TRIGGER task_steps_owner_insert BEFORE INSERT ON task_steps
WHEN NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=new.task_id AND t.owner_id=new.owner_id)
BEGIN SELECT RAISE(ABORT,'task step owner does not match task owner'); END;
CREATE TRIGGER task_steps_owner_update BEFORE UPDATE OF owner_id,task_id ON task_steps
WHEN NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=new.task_id AND t.owner_id=new.owner_id)
BEGIN SELECT RAISE(ABORT,'task step owner does not match task owner'); END;

CREATE VIRTUAL TABLE task_steps_fts USING fts5(
  text,
  content='task_steps',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER task_steps_fts_insert AFTER INSERT ON task_steps BEGIN
  INSERT INTO task_steps_fts(rowid,text) VALUES(new.rowid,new.text);
END;
CREATE TRIGGER task_steps_fts_delete AFTER DELETE ON task_steps BEGIN
  INSERT INTO task_steps_fts(task_steps_fts,rowid,text) VALUES('delete',old.rowid,old.text);
END;
CREATE TRIGGER task_steps_fts_update AFTER UPDATE OF text ON task_steps BEGIN
  INSERT INTO task_steps_fts(task_steps_fts,rowid,text) VALUES('delete',old.rowid,old.text);
  INSERT INTO task_steps_fts(rowid,text) VALUES(new.rowid,new.text);
END;

CREATE TRIGGER task_steps_ai_insert AFTER INSERT ON task_steps BEGIN
  UPDATE ai_content SET generation=generation+1,state='pending',failures=0,retry_after=0
  WHERE source_key='task:'||new.task_id;
END;
CREATE TRIGGER task_steps_ai_update AFTER UPDATE OF text,position ON task_steps
WHEN old.text IS NOT new.text OR old.position IS NOT new.position
BEGIN
  UPDATE ai_content SET generation=generation+1,state='pending',failures=0,retry_after=0
  WHERE source_key='task:'||new.task_id;
END;
CREATE TRIGGER task_steps_ai_delete AFTER DELETE ON task_steps BEGIN
  UPDATE ai_content SET generation=generation+1,state='pending',failures=0,retry_after=0
  WHERE source_key='task:'||old.task_id;
END;

DROP VIEW ai_sources;
CREATE VIEW ai_sources AS SELECT 'note:'||n.id AS source_key,'note' AS source_kind,n.id AS source_id,n.owner_id AS owner_id,'note' AS item_kind,n.id AS item_id,n.title AS title,n.text||' '||coalesce(n.daily_date,'') AS text,(n.trashed_at IS NULL AND n.kind='note') AS active,n.created_at AS created_at,n.updated_at AS updated_at FROM notes n
UNION ALL
SELECT 'task:'||t.id AS source_key,'task' AS source_kind,t.id AS source_id,t.owner_id AS owner_id,'task' AS item_kind,t.id AS item_id,t.title AS title,t.title||' '||coalesce(t.due_date,'')||' '||coalesce(t.planned_date,'')||' '||coalesce(t.schedule_start_local,'')||' '||coalesce(t.schedule_timezone,'')||' '||coalesce((SELECT group_concat(step.text,' ') FROM (SELECT text FROM task_steps WHERE task_id=t.id ORDER BY position) step),'') AS text,(t.trashed_at IS NULL) AS active,t.created_at AS created_at,t.updated_at AS updated_at FROM tasks t
UNION ALL
SELECT 'bookmark:'||b.id AS source_key,'bookmark' AS source_kind,b.id AS source_id,b.owner_id AS owner_id,'bookmark' AS item_kind,b.id AS item_id,b.title AS title,b.description||' '||b.url||' '||b.collection AS text,(b.trashed_at IS NULL) AS active,b.created_at AS created_at,b.updated_at AS updated_at FROM bookmarks b
UNION ALL
SELECT 'artifact:'||a.id AS source_key,'artifact' AS source_kind,a.id AS source_id,a.owner_id AS owner_id,'artifact' AS item_kind,a.id AS item_id,coalesce(nullif(a.name,''),a.title) AS title,a.title||' '||a.name||' '||a.content AS text,(a.trashed_at IS NULL) AS active,a.created_at AS created_at,a.updated_at AS updated_at FROM artifacts a
UNION ALL
SELECT 'event:'||e.id AS source_key,'event' AS source_kind,e.id AS source_id,e.owner_id AS owner_id,'event' AS item_kind,e.id AS item_id,e.title AS title,e.description||' '||e.data AS text,(e.trashed_at IS NULL) AS active,e.created_at AS created_at,e.updated_at AS updated_at FROM calendar_events e
UNION ALL
SELECT 'form:'||f.id AS source_key,'form' AS source_kind,f.id AS source_id,f.owner_id AS owner_id,'form' AS item_kind,f.id AS item_id,f.title AS title,f.description||' '||f.definition AS text,(f.trashed_at IS NULL) AS active,f.created_at AS created_at,f.updated_at AS updated_at FROM forms f
UNION ALL
SELECT 'response:'||r.id AS source_key,'response' AS source_kind,r.id AS source_id,f.owner_id AS owner_id,'response' AS item_kind,r.id AS item_id,f.title||' — response' AS title,r.search_text AS text,(r.trashed_at IS NULL AND f.trashed_at IS NULL) AS active,r.created_at AS created_at,r.created_at AS updated_at FROM form_responses r JOIN forms f ON f.id=r.form_id
UNION ALL
SELECT 'attachment:'||a.id AS source_key,'attachment' AS source_kind,a.id AS source_id,n.owner_id AS owner_id,'note' AS item_kind,n.id AS item_id,a.name AS title,a.name||' '||coalesce(x.text,'') AS text,(n.trashed_at IS NULL AND instr(n.document,a.id)>0) AS active,a.created_at AS created_at,a.created_at AS updated_at FROM attachments a JOIN notes n ON n.id=a.note_id LEFT JOIN ai_extractions x ON x.source_key='attachment:'||a.id
UNION ALL
SELECT 'form-file:'||ff.id AS source_key,'form-file' AS source_kind,ff.id AS source_id,f.owner_id AS owner_id,'response' AS item_kind,r.id AS item_id,ff.filename AS title,ff.filename||' '||coalesce(x.text,'') AS text,(ff.state='attached' AND r.trashed_at IS NULL AND f.trashed_at IS NULL) AS active,ff.created_at AS created_at,ff.created_at AS updated_at FROM form_files ff JOIN forms f ON f.id=ff.form_id JOIN form_responses r ON r.id=ff.response_id LEFT JOIN ai_extractions x ON x.source_key='form-file:'||ff.id;

DROP TRIGGER tasks_ai_update;
CREATE TRIGGER tasks_ai_update AFTER UPDATE OF title,due_date,planned_date,schedule_start_local,schedule_timezone,schedule_duration_minutes,recurrence_rule_json,trashed_at,owner_id ON tasks
WHEN old.title IS NOT new.title OR old.due_date IS NOT new.due_date OR old.planned_date IS NOT new.planned_date OR old.schedule_start_local IS NOT new.schedule_start_local OR old.schedule_timezone IS NOT new.schedule_timezone OR old.schedule_duration_minutes IS NOT new.schedule_duration_minutes OR old.recurrence_rule_json IS NOT new.recurrence_rule_json OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id
BEGIN
  INSERT INTO ai_content(source_key) VALUES('task:'||new.id)
  ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
END;
