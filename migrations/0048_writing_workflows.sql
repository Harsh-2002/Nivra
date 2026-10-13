ALTER TABLE notes ADD COLUMN journal_period TEXT
  CHECK (journal_period IN ('daily', 'weekly', 'monthly'));
ALTER TABLE notes ADD COLUMN journal_period_start TEXT;

UPDATE notes
SET journal_period='daily', journal_period_start=daily_date
WHERE kind='note' AND daily_date IS NOT NULL;

CREATE UNIQUE INDEX notes_owner_journal_period_start_idx
  ON notes(owner_id, journal_period, journal_period_start)
  WHERE kind='note' AND journal_period IS NOT NULL;
CREATE INDEX notes_journal_period_active_idx
  ON notes(owner_id, journal_period, journal_period_start, updated_at DESC, id)
  WHERE kind='note' AND journal_period IS NOT NULL AND trashed_at IS NULL;

CREATE TABLE writing_templates (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('note', 'journal')),
  document TEXT NOT NULL CHECK(json_valid(document)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX writing_templates_owner_kind_name_idx
  ON writing_templates(owner_id, kind, lower(name));
CREATE INDEX writing_templates_owner_updated_idx
  ON writing_templates(owner_id, updated_at DESC, id);

CREATE TABLE writing_template_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES writing_templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX writing_template_attachments_template_idx
  ON writing_template_attachments(owner_id, template_id, id);
CREATE TRIGGER writing_template_attachments_owner_insert
BEFORE INSERT ON writing_template_attachments
WHEN NOT EXISTS (
  SELECT 1 FROM writing_templates t
  WHERE t.id=NEW.template_id AND t.owner_id=NEW.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Template attachment must belong to the template owner.'); END;
CREATE TRIGGER writing_template_attachments_owner_update
BEFORE UPDATE OF owner_id, template_id ON writing_template_attachments
WHEN NOT EXISTS (
  SELECT 1 FROM writing_templates t
  WHERE t.id=NEW.template_id AND t.owner_id=NEW.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Template attachment must belong to the template owner.'); END;

CREATE TABLE writing_preferences (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  default_journal_template_id TEXT REFERENCES writing_templates(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER writing_preferences_default_owner_insert
BEFORE INSERT ON writing_preferences
WHEN NEW.default_journal_template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM writing_templates
  WHERE id=NEW.default_journal_template_id AND owner_id=NEW.owner_id AND kind='journal'
)
BEGIN SELECT RAISE(ABORT, 'Default journal template must belong to the owner.'); END;
CREATE TRIGGER writing_preferences_default_owner_update
BEFORE UPDATE OF default_journal_template_id, owner_id ON writing_preferences
WHEN NEW.default_journal_template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM writing_templates
  WHERE id=NEW.default_journal_template_id AND owner_id=NEW.owner_id AND kind='journal'
)
BEGIN SELECT RAISE(ABORT, 'Default journal template must belong to the owner.'); END;

CREATE TABLE note_task_links (
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(note_id, block_id)
);
CREATE INDEX note_task_links_task_idx ON note_task_links(owner_id, task_id, note_id);
CREATE TRIGGER note_task_links_owner_insert
BEFORE INSERT ON note_task_links
WHEN NOT EXISTS (
  SELECT 1 FROM notes n
  WHERE n.id=NEW.note_id AND n.owner_id=NEW.owner_id AND n.kind='note'
    AND n.daily_date IS NULL AND n.journal_period IS NULL
) OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks t WHERE t.id=NEW.task_id AND t.owner_id=NEW.owner_id
))
BEGIN SELECT RAISE(ABORT, 'Linked task and note must belong to the owner.'); END;
CREATE TRIGGER note_task_links_owner_update
BEFORE UPDATE OF owner_id, note_id, task_id ON note_task_links
WHEN NOT EXISTS (
  SELECT 1 FROM notes n
  WHERE n.id=NEW.note_id AND n.owner_id=NEW.owner_id AND n.kind='note'
    AND n.daily_date IS NULL AND n.journal_period IS NULL
) OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks t WHERE t.id=NEW.task_id AND t.owner_id=NEW.owner_id
))
BEGIN SELECT RAISE(ABORT, 'Linked task and note must belong to the owner.'); END;

CREATE TABLE note_task_idempotency (
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  block_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, note_id, idempotency_key)
);
CREATE TRIGGER note_task_idempotency_owner_insert
BEFORE INSERT ON note_task_idempotency
WHEN NOT EXISTS (
  SELECT 1 FROM notes n
  WHERE n.id=NEW.note_id AND n.owner_id=NEW.owner_id
) OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks t WHERE t.id=NEW.task_id AND t.owner_id=NEW.owner_id
))
BEGIN SELECT RAISE(ABORT, 'Task idempotency record must belong to its owner.'); END;

CREATE TABLE writing_template_applications (
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES writing_templates(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, template_id, idempotency_key)
);
CREATE TRIGGER writing_template_applications_owner_insert
BEFORE INSERT ON writing_template_applications
WHEN NOT EXISTS (
  SELECT 1 FROM writing_templates t
  WHERE t.id=NEW.template_id AND t.owner_id=NEW.owner_id
) OR (NEW.note_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM notes n WHERE n.id=NEW.note_id AND n.owner_id=NEW.owner_id
))
BEGIN SELECT RAISE(ABORT, 'Template application must belong to its owner.'); END;
