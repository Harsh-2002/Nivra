CREATE INDEX calendar_events_export_active_once_idx ON calendar_events(owner_id,end_date,start_date) WHERE trashed_at IS NULL AND recurring=0;
CREATE INDEX calendar_events_export_active_repeat_idx ON calendar_events(owner_id,start_date) WHERE trashed_at IS NULL AND recurring=1;
