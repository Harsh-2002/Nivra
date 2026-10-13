CREATE INDEX notes_journal_date_page_idx
  ON notes(owner_id, coalesce(journal_period_start,daily_date) DESC, id)
  WHERE kind='note' AND trashed_at IS NULL
    AND (journal_period IS NOT NULL OR daily_date IS NOT NULL);

CREATE INDEX notes_journal_period_page_idx
  ON notes(
    owner_id,
    coalesce(journal_period,CASE WHEN daily_date IS NOT NULL THEN 'daily' END),
    coalesce(journal_period_start,daily_date) DESC,
    id
  )
  WHERE kind='note' AND trashed_at IS NULL
    AND (journal_period IS NOT NULL OR daily_date IS NOT NULL);
