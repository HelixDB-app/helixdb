/**
 * Curated read-only diagnostics for Database Vitals.
 * Uses current_database() / session context only — no string interpolation of connection metadata.
 *
 * Privileges: Most queries need CONNECT on the DB. pg_stat_bgwriter may require pg_monitor or superuser.
 */

/** Handoff from Database Vitals “Open in Query” to workspace query editor (read in `page.tsx`). */
export const PGSTUDIO_PENDING_QUERY_TAB_KEY = "pgstudio_pending_query_tab";

/** Single-row snapshot for the connected database (pg_stat_database). */
export const SQL_OVERVIEW_DATABASE_STATS = `
SELECT
  numbackends,
  xact_commit,
  xact_rollback,
  blks_read,
  blks_hit,
  CASE WHEN blks_read + blks_hit > 0
    THEN round(100.0 * blks_hit / NULLIF(blks_read + blks_hit, 0), 2)
    ELSE NULL END AS buffer_hit_pct,
  tup_returned,
  tup_fetched,
  tup_inserted,
  tup_updated,
  tup_deleted,
  conflicts,
  deadlocks,
  temp_files,
  pg_size_pretty(temp_bytes::bigint) AS temp_bytes_pretty,
  blk_read_time,
  blk_write_time,
  stats_reset
FROM pg_stat_database
WHERE datname = current_database();
`.trim();

/** Server-wide connection ceiling vs usage. */
export const SQL_OVERVIEW_CONNECTIONS = `
SELECT
  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
  (SELECT count(*)::int FROM pg_stat_activity) AS total_backends,
  (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS backends_this_db;
`.trim();

/** Backends grouped by state for this database. */
export const SQL_OVERVIEW_ACTIVITY_BY_STATE = `
SELECT
  coalesce(state, 'null') AS state,
  count(*)::int AS connections
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY connections DESC;
`.trim();

/** Simple replication role (10+). */
export const SQL_OVERVIEW_RECOVERY = `
SELECT
  pg_is_in_recovery() AS is_in_recovery;
`.trim();

/** Cluster-wide IO stats; may fail without pg_monitor / superuser. */
export const SQL_OVERVIEW_BGWRITER = `
SELECT
  checkpoints_timed,
  checkpoints_req,
  checkpoint_write_time,
  checkpoint_sync_time,
  buffers_checkpoint,
  buffers_clean,
  buffers_backend,
  buffers_alloc,
  stats_reset
FROM pg_stat_bgwriter;
`.trim();

/** Largest user tables by total relation size. */
export const SQL_STORAGE_LARGEST_RELATIONS = `
SELECT
  schemaname,
  relname,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_total_relation_size(relid) AS total_bytes,
  n_live_tup::bigint AS n_live_tup,
  n_dead_tup::bigint AS n_dead_tup,
  CASE WHEN (n_live_tup + n_dead_tup) > 0
    THEN round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)
    ELSE NULL END AS dead_tuple_pct,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC NULLS LAST
LIMIT 50;
`.trim();

/** Tables with high dead-tuple ratio (maintenance candidates). */
export const SQL_STORAGE_BLOAT_CANDIDATES = `
SELECT
  schemaname,
  relname,
  n_live_tup::bigint AS n_live_tup,
  n_dead_tup::bigint AS n_dead_tup,
  CASE WHEN (n_live_tup + n_dead_tup) > 0
    THEN round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)
    ELSE NULL END AS dead_tuple_pct,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  last_autovacuum,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE n_live_tup + n_dead_tup >= 1000
  AND n_dead_tup > 0
  AND (100.0 * n_dead_tup / (n_live_tup + n_dead_tup)) >= 10
ORDER BY dead_tuple_pct DESC NULLS LAST
LIMIT 40;
`.trim();

/** User indexes with zero scans (excludes primary keys). */
export const SQL_INDEXES_UNUSED = `
SELECT
  s.schemaname,
  s.relname AS table_name,
  s.indexrelname AS index_name,
  s.idx_scan,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
  i.indisunique AS is_unique
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC NULLS LAST
LIMIT 80;
`.trim();

/** Indexes that are not yet valid (e.g. failed CONCURRENTLY). */
export const SQL_INDEXES_INVALID = `
SELECT
  n.nspname AS schema_name,
  t.relname AS table_name,
  ic.relname AS index_name
FROM pg_index x
JOIN pg_class ic ON ic.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT x.indisvalid
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, t.relname, ic.relname;
`.trim();

/** Long-running active queries on this database (excludes this session). */
export const SQL_ACTIVITY_LONG_RUNNING = `
SELECT
  pid,
  usename::text AS usename,
  coalesce(application_name, '') AS application_name,
  client_addr::text AS client_addr,
  state,
  now() - query_start AS query_duration,
  wait_event_type,
  wait_event,
  left(query, 400) AS query_preview
FROM pg_stat_activity
WHERE datname = current_database()
  AND state = 'active'
  AND pid <> pg_backend_pid()
ORDER BY query_start ASC NULLS LAST
LIMIT 40;
`.trim();

export const VITALS_QUERY_LABELS: Record<string, string> = {
    overview_db: "Overview — pg_stat_database",
    overview_conn: "Overview — connections",
    overview_state: "Overview — activity by state",
    overview_recovery: "Overview — recovery",
    overview_bgwriter: "Overview — pg_stat_bgwriter",
    storage_size: "Storage — largest relations",
    storage_bloat: "Storage — dead-tuple candidates (≥10%)",
    indexes_unused: "Indexes — never scanned (non-PK)",
    indexes_invalid: "Indexes — invalid",
    activity_long: "Activity — long-running active",
};
