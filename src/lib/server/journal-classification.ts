export function journalPeriodSql(alias: string) {
  return `coalesce(${alias}.journal_period,CASE WHEN ${alias}.daily_date IS NOT NULL THEN 'daily' END)`;
}

export function journalKindSql(alias: string) {
  return `CASE WHEN ${journalPeriodSql(alias)} IS NULL THEN 'note' ELSE 'journal' END`;
}

export function journalStartSql(alias: string) {
  return `coalesce(${alias}.journal_period_start,${alias}.daily_date)`;
}
