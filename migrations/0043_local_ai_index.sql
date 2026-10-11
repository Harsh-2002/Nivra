ALTER TABLE tags ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases) AND json_type(aliases)='array');
CREATE TABLE ai_configuration (
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)), revision INTEGER NOT NULL DEFAULT 1, public_next_at INTEGER NOT NULL DEFAULT 0, vocabulary_generation INTEGER NOT NULL DEFAULT 1, chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count>=0), index_generation INTEGER NOT NULL DEFAULT 1
);
INSERT INTO ai_configuration(id) VALUES(1);
CREATE TABLE ai_content (
  source_key TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN(0,1)), owner_id TEXT REFERENCES user(id) ON DELETE CASCADE, item_kind TEXT, item_id TEXT, vocabulary_generation INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','indexed','empty','failed','capacity')), fingerprint TEXT, model_version TEXT, indexed_generation INTEGER, retry_after INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_content_owner ON ai_content(owner_id,state,source_key);
CREATE INDEX ai_content_pending ON ai_content(retry_after,source_key) WHERE pending=1 AND failures<3;
CREATE TRIGGER ai_content_insert_epoch AFTER INSERT ON ai_content BEGIN UPDATE ai_configuration SET index_generation=index_generation+1 WHERE id=1; END;
CREATE TRIGGER ai_content_delete_epoch AFTER DELETE ON ai_content BEGIN UPDATE ai_configuration SET index_generation=index_generation+1 WHERE id=1; END;
CREATE TABLE ai_chunks (
  source_key TEXT NOT NULL REFERENCES ai_content(source_key) ON DELETE CASCADE, ordinal INTEGER NOT NULL, generation INTEGER NOT NULL, model_version TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, dimensions INTEGER NOT NULL DEFAULT 384 CHECK(dimensions>0 AND dimensions<=4096), modality TEXT NOT NULL DEFAULT 'text' CHECK(modality IN('text','image')), embedding BLOB NOT NULL CHECK(length(embedding)=dimensions*4), UNIQUE(source_key,model_version,modality,ordinal)
);
CREATE INDEX ai_chunks_source_generation ON ai_chunks(source_key,generation,model_version);
CREATE VIRTUAL TABLE ai_chunks_fts USING fts5(title,text,content='ai_chunks',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER ai_chunks_insert AFTER INSERT ON ai_chunks BEGIN INSERT INTO ai_chunks_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text); UPDATE ai_configuration SET index_generation=index_generation+1,chunk_count=chunk_count+1 WHERE id=1; END;
CREATE TRIGGER ai_chunks_delete AFTER DELETE ON ai_chunks BEGIN INSERT INTO ai_chunks_fts(ai_chunks_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text); UPDATE ai_configuration SET index_generation=index_generation+1,chunk_count=chunk_count-1 WHERE id=1; END;
CREATE TRIGGER ai_chunks_update AFTER UPDATE OF title,text ON ai_chunks BEGIN
 INSERT INTO ai_chunks_fts(ai_chunks_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text);
 INSERT INTO ai_chunks_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text);
END;
CREATE TRIGGER ai_chunks_epoch_update AFTER UPDATE ON ai_chunks BEGIN UPDATE ai_configuration SET index_generation=index_generation+1 WHERE id=1; END;
CREATE TABLE ai_suggestions (
  source_key TEXT PRIMARY KEY REFERENCES ai_content(source_key) ON DELETE CASCADE, id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, fingerprint TEXT NOT NULL, score REAL NOT NULL, model_version TEXT NOT NULL, vocabulary_generation INTEGER NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
);
CREATE TABLE ai_decisions (
 source_key TEXT NOT NULL REFERENCES ai_content(source_key) ON DELETE CASCADE, fingerprint TEXT NOT NULL, tag_id TEXT NOT NULL, tag_fingerprint TEXT NOT NULL, proposal_id TEXT UNIQUE, decision TEXT NOT NULL CHECK(decision IN('accepted','rejected')), created_at INTEGER NOT NULL, PRIMARY KEY(source_key,fingerprint,tag_id,tag_fingerprint,decision)
);
CREATE TABLE ai_extractions (
 source_key TEXT PRIMARY KEY REFERENCES ai_content(source_key) ON DELETE CASCADE, storage_key TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN('done','unavailable','failed'))
);
CREATE TABLE response_tags (
 response_id TEXT NOT NULL REFERENCES form_responses(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(response_id,tag_id)
);
CREATE INDEX response_tags_tag_idx ON response_tags(tag_id,response_id);
CREATE TRIGGER ai_content_dirty AFTER UPDATE OF generation ON ai_content WHEN old.generation IS NOT new.generation BEGIN
 UPDATE ai_configuration SET index_generation=index_generation+1 WHERE id=1;
 UPDATE ai_content SET pending=1 WHERE source_key=new.source_key;
 DELETE FROM ai_chunks WHERE source_key=new.source_key;
 DELETE FROM ai_suggestions WHERE source_key=new.source_key;
END;
CREATE TRIGGER ai_vocabulary_insert AFTER INSERT ON tags BEGIN UPDATE ai_configuration SET vocabulary_generation=vocabulary_generation+1 WHERE id=1; DELETE FROM ai_suggestions; UPDATE ai_content SET pending=1,failures=0,retry_after=0; END;
CREATE TRIGGER ai_vocabulary_update AFTER UPDATE OF name,aliases ON tags WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases BEGIN UPDATE ai_configuration SET vocabulary_generation=vocabulary_generation+1 WHERE id=1; DELETE FROM ai_suggestions; UPDATE ai_content SET pending=1,failures=0,retry_after=0; END;
CREATE TRIGGER ai_vocabulary_delete AFTER DELETE ON tags BEGIN UPDATE ai_configuration SET vocabulary_generation=vocabulary_generation+1 WHERE id=1; DELETE FROM ai_suggestions; UPDATE ai_content SET pending=1,failures=0,retry_after=0; END;
CREATE TRIGGER notes_ai_insert AFTER INSERT ON notes BEGIN INSERT INTO ai_content(source_key) VALUES('note:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER notes_ai_update AFTER UPDATE OF title,text,document,trashed_at,daily_date,owner_id ON notes WHEN old.title IS NOT new.title OR old.text IS NOT new.text OR old.document IS NOT new.document OR old.trashed_at IS NOT new.trashed_at OR old.daily_date IS NOT new.daily_date OR old.owner_id IS NOT new.owner_id BEGIN INSERT INTO ai_content(source_key) VALUES('note:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER notes_ai_delete AFTER DELETE ON notes BEGIN DELETE FROM ai_content WHERE source_key='note:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'note:'||id FROM notes;
CREATE TRIGGER tasks_ai_insert AFTER INSERT ON tasks BEGIN INSERT INTO ai_content(source_key) VALUES('task:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER tasks_ai_update AFTER UPDATE OF title,due_date,planned_date,trashed_at,owner_id ON tasks WHEN old.title IS NOT new.title OR old.due_date IS NOT new.due_date OR old.planned_date IS NOT new.planned_date OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN INSERT INTO ai_content(source_key) VALUES('task:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER tasks_ai_delete AFTER DELETE ON tasks BEGIN DELETE FROM ai_content WHERE source_key='task:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'task:'||id FROM tasks;
CREATE TRIGGER bookmarks_ai_insert AFTER INSERT ON bookmarks BEGIN INSERT INTO ai_content(source_key) VALUES('bookmark:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER bookmarks_ai_update AFTER UPDATE OF title,description,url,collection,trashed_at,owner_id ON bookmarks WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.url IS NOT new.url OR old.collection IS NOT new.collection OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN INSERT INTO ai_content(source_key) VALUES('bookmark:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER bookmarks_ai_delete AFTER DELETE ON bookmarks BEGIN DELETE FROM ai_content WHERE source_key='bookmark:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'bookmark:'||id FROM bookmarks;
CREATE TRIGGER artifacts_ai_insert AFTER INSERT ON artifacts BEGIN INSERT INTO ai_content(source_key) VALUES('artifact:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER artifacts_ai_update AFTER UPDATE OF title,name,content,trashed_at,owner_id ON artifacts WHEN old.title IS NOT new.title OR old.name IS NOT new.name OR old.content IS NOT new.content OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN INSERT INTO ai_content(source_key) VALUES('artifact:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER artifacts_ai_delete AFTER DELETE ON artifacts BEGIN DELETE FROM ai_content WHERE source_key='artifact:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'artifact:'||id FROM artifacts;
CREATE TRIGGER calendar_events_ai_insert AFTER INSERT ON calendar_events BEGIN INSERT INTO ai_content(source_key) VALUES('event:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER calendar_events_ai_update AFTER UPDATE OF title,description,data,trashed_at,owner_id ON calendar_events WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.data IS NOT new.data OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN INSERT INTO ai_content(source_key) VALUES('event:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER calendar_events_ai_delete AFTER DELETE ON calendar_events BEGIN DELETE FROM ai_content WHERE source_key='event:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'event:'||id FROM calendar_events;
CREATE TRIGGER forms_ai_insert AFTER INSERT ON forms BEGIN INSERT INTO ai_content(source_key) VALUES('form:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER forms_ai_update AFTER UPDATE OF title,description,definition,closing_date,closing_timezone,status,trashed_at,owner_id ON forms WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.definition IS NOT new.definition OR old.closing_date IS NOT new.closing_date OR old.closing_timezone IS NOT new.closing_timezone OR old.status IS NOT new.status OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN INSERT INTO ai_content(source_key) VALUES('form:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER forms_ai_delete AFTER DELETE ON forms BEGIN DELETE FROM ai_content WHERE source_key='form:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'form:'||id FROM forms;
CREATE TRIGGER form_responses_ai_insert AFTER INSERT ON form_responses BEGIN INSERT INTO ai_content(source_key) VALUES('response:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER form_responses_ai_update AFTER UPDATE OF trashed_at ON form_responses WHEN old.trashed_at IS NOT new.trashed_at BEGIN INSERT INTO ai_content(source_key) VALUES('response:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER form_responses_ai_delete AFTER DELETE ON form_responses BEGIN DELETE FROM ai_content WHERE source_key='response:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'response:'||id FROM form_responses;
CREATE TRIGGER attachments_ai_insert AFTER INSERT ON attachments BEGIN INSERT INTO ai_content(source_key) VALUES('attachment:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER attachments_ai_update AFTER UPDATE OF note_id,name,mime,storage_key ON attachments WHEN old.note_id IS NOT new.note_id OR old.name IS NOT new.name OR old.mime IS NOT new.mime OR old.storage_key IS NOT new.storage_key BEGIN
 INSERT INTO ai_content(source_key) VALUES('attachment:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
 DELETE FROM ai_extractions WHERE source_key='attachment:'||new.id AND (old.name IS NOT new.name OR old.mime IS NOT new.mime OR old.storage_key IS NOT new.storage_key);
END;
CREATE TRIGGER attachments_ai_delete AFTER DELETE ON attachments BEGIN DELETE FROM ai_content WHERE source_key='attachment:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'attachment:'||id FROM attachments;
CREATE TRIGGER form_files_ai_insert AFTER INSERT ON form_files BEGIN INSERT INTO ai_content(source_key) VALUES('form-file:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0; END;
CREATE TRIGGER form_files_ai_update AFTER UPDATE OF response_id,state,filename,mime,storage_key ON form_files WHEN old.response_id IS NOT new.response_id OR old.state IS NOT new.state OR old.filename IS NOT new.filename OR old.mime IS NOT new.mime OR old.storage_key IS NOT new.storage_key BEGIN
 INSERT INTO ai_content(source_key) VALUES('form-file:'||new.id) ON CONFLICT(source_key) DO UPDATE SET generation=generation+1,state='pending',failures=0,retry_after=0;
 DELETE FROM ai_extractions WHERE source_key='form-file:'||new.id AND (old.filename IS NOT new.filename OR old.mime IS NOT new.mime OR old.storage_key IS NOT new.storage_key);
END;
CREATE TRIGGER form_files_ai_delete AFTER DELETE ON form_files BEGIN DELETE FROM ai_content WHERE source_key='form-file:'||old.id; END;
INSERT INTO ai_content(source_key) SELECT 'form-file:'||id FROM form_files;
CREATE VIEW ai_sources AS SELECT 'note:'||n.id AS source_key,'note' AS source_kind,n.id AS source_id,n.owner_id AS owner_id,'note' AS item_kind,n.id AS item_id,n.title AS title,n.text||' '||coalesce(n.daily_date,'') AS text,(n.trashed_at IS NULL AND n.kind='note') AS active,n.created_at AS created_at,n.updated_at AS updated_at FROM notes n
UNION ALL
SELECT 'task:'||t.id AS source_key,'task' AS source_kind,t.id AS source_id,t.owner_id AS owner_id,'task' AS item_kind,t.id AS item_id,t.title AS title,t.title||' '||coalesce(t.due_date,'')||' '||coalesce(t.planned_date,'') AS text,(t.trashed_at IS NULL) AS active,t.created_at AS created_at,t.updated_at AS updated_at FROM tasks t
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
CREATE TRIGGER ai_note_children AFTER UPDATE OF document,trashed_at,owner_id ON notes WHEN old.document IS NOT new.document OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN
 UPDATE ai_content SET generation=generation+1,state='pending',failures=0,retry_after=0 WHERE source_key IN(SELECT 'attachment:'||id FROM attachments WHERE note_id=new.id);
END;
CREATE TRIGGER ai_form_children AFTER UPDATE OF title,definition,trashed_at,owner_id ON forms WHEN old.title IS NOT new.title OR old.definition IS NOT new.definition OR old.trashed_at IS NOT new.trashed_at OR old.owner_id IS NOT new.owner_id BEGIN
 UPDATE ai_content SET generation=generation+1,state='pending',failures=0,retry_after=0 WHERE source_key IN(SELECT 'response:'||id FROM form_responses WHERE form_id=new.id UNION ALL SELECT 'form-file:'||id FROM form_files WHERE form_id=new.id);
END;
CREATE TRIGGER ai_response_children AFTER UPDATE OF trashed_at ON form_responses WHEN old.trashed_at IS NOT new.trashed_at BEGIN
 UPDATE ai_content SET generation=generation+1,state='pending',failures=0,retry_after=0 WHERE source_key IN(SELECT 'form-file:'||id FROM form_files WHERE response_id=new.id);
END;
