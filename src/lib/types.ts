// TypeScript mirrors of Rust types from src-tauri/src/db/types.rs

export interface CellValue {
    type:
    | "Null"
    | "Bool"
    | "Int16"
    | "Int32"
    | "Int64"
    | "Float32"
    | "Float64"
    | "String"
    | "Json"
    | "DateTime"
    | "Date"
    | "Time"
    | "Uuid"
    | "Bytes";
    value?: unknown;
}

export interface ColumnInfo {
    name: string;
    data_type: string;
    is_nullable: boolean;
    ordinal_position: number;
    column_default: string | null;
    is_primary_key: boolean;
    /** PostgreSQL `GENERATED ... AS (...)` stored column — must not appear in INSERT/UPDATE values. */
    is_generated?: boolean;
    comment: string | null;
}

/** Columns that accept literals on INSERT (excludes generated STORED columns). */
export function writableInsertColumns(columns: ColumnInfo[]): ColumnInfo[] {
    return columns.filter((c) => !c.is_generated);
}

export interface SchemaInfo {
    name: string;
    table_count: number;
}

export interface TableInfo {
    name: string;
    schema: string;
    row_count: number;
    table_type: string;
    table_comment: string | null;
}

export interface RecentTableOpen {
    schema: string;
    table: string;
    table_type: string;
    opened_at: number;
}

export interface QueryResult {
    columns: ResultColumn[];
    rows: CellValue[][];
    row_count: number;
    total_rows: number | null;
    execution_time_ms: number;
    page: number | null;
    page_size: number | null;
    query: string;
    is_error: boolean;
    error_message: string | null;
}

/** Query history list/search filter */
export interface QueryHistoryFilter {
    search_text?: string | null;
    connection_id?: string | null;
    status?: string | null;
    query_type?: string | null;
    was_cached?: boolean | null;
    bookmark_only?: boolean | null;
    min_time_ms?: number | null;
    max_time_ms?: number | null;
    from_time?: number | null;
    to_time?: number | null;
    tables?: string[] | null;
    sort_by?: string | null;
    sort_dir?: "asc" | "desc" | string | null;
    limit?: number | null;
    offset?: number | null;
}

export type ConnectionEnvironment = "dev" | "staging" | "prod";
export type ConnectionCriticality = "low" | "medium" | "high";

/** One query row in history list */
export interface QueryHistorySummary {
    id: number;
    query_text: string;
    query_hash: number;
    connection_id: string;
    connection_label: string;
    executed_at: number;
    planning_ms: number | null;
    execution_ms: number;
    total_ms: number;
    rows_returned: number | null;
    rows_affected: number | null;
    status: string;
    error_code: string | null;
    error_message: string | null;
    blks_hit: number | null;
    blks_read: number | null;
    temp_blks_written: number | null;
    query_type: string;
    tables_touched: string[];
    was_cached: boolean;
    run_count: number;
    avg_ms: number;
    fastest_ms: number;
    slowest_ms: number;
    bookmark: boolean;
    note: string | null;
    environment: ConnectionEnvironment | null;
    guard_reason: string | null;
}

export interface QueryHistoryPeer {
    id: number;
    query_text: string;
    executed_at: number;
    total_ms: number;
    status: string;
    connection_label: string;
}

/** Detail payload for one query history item */
export interface QueryHistoryDetail {
    item: QueryHistorySummary;
    query_normalized: string;
    explain_json: string | null;
    ai_analysis: string | null;
    similar_by_hash: QueryHistoryPeer[];
    similar_by_table: QueryHistoryPeer[];
}

export interface QueryHistoryStats {
    total_queries: number;
    avg_time_ms: number;
    slowest_ms: number;
    failed_count: number;
    cached_count: number;
    today_count: number;
}

export interface QueryHistoryConnectionInfo {
    connection_id: string;
    connection_label: string;
    query_count: number;
}

export interface QueryHistoryListResponse {
    items: QueryHistorySummary[];
    total_count: number;
    stats: QueryHistoryStats;
    connections: QueryHistoryConnectionInfo[];
}

export interface QueryHistoryDashboardFilter {
    connection_id?: string | null;
    from_time?: number | null;
    to_time?: number | null;
}

export interface QueryDashboardPoint {
    bucket_start: number;
    avg_ms: number;
    total_count: number;
    failed_count: number;
    error_rate: number;
    cache_hit_rate: number;
}

export interface QueryVolumeHourPoint {
    hour: number;
    count: number;
}

export interface QueryDashboardSlowItem {
    query_hash: number;
    query_text: string;
    slowest_ms: number;
    avg_ms: number;
    run_count: number;
}

export interface QueryDashboardTableFrequency {
    table_name: string;
    count: number;
}

export interface QueryAnomaly {
    query_hash: number;
    query_text: string;
    previous_avg_ms: number;
    recent_avg_ms: number;
    delta_factor: number;
}

export interface QueryHistoryDashboard {
    trend: QueryDashboardPoint[];
    volume_by_hour: QueryVolumeHourPoint[];
    top_slowest: QueryDashboardSlowItem[];
    table_frequency: QueryDashboardTableFrequency[];
    anomalies: QueryAnomaly[];
}

/** Runtime status of pg_stat_statements for the current DB connection. */
export interface PgStatStatementsStatus {
    extension_installed: boolean;
    preload_enabled: boolean;
    can_query: boolean;
    shared_preload_libraries: string | null;
    message: string | null;
}

/** Search/sort/pagination payload for pg_stat_statements list queries. */
export interface PgStatStatementsFilter {
    search_text?: string | null;
    min_mean_ms?: number | null;
    /** slowest | max | total | calls | rows | disk */
    sort_by?: string | null;
    /** ASC | DESC */
    sort_dir?: string | null;
    limit?: number | null;
    offset?: number | null;
}

/** One row from pg_stat_statements. */
export interface PgStatStatementEntry {
    query_id: string;
    query: string;
    calls: number;
    total_exec_time_ms: number;
    mean_exec_time_ms: number;
    min_exec_time_ms: number;
    max_exec_time_ms: number;
    stddev_exec_time_ms: number | null;
    rows: number;
    shared_blks_hit: number;
    shared_blks_read: number;
    temp_blks_written: number;
    blk_read_time_ms: number | null;
    blk_write_time_ms: number | null;
    hit_percent: number;
    slow_call_estimate: number;
}

/** Paginated response from pg_stat_statements list API. */
export interface PgStatStatementsPage {
    items: PgStatStatementEntry[];
    total_count: number;
    limit: number;
    offset: number;
    has_more: boolean;
}

export interface ResultColumn {
    name: string;
    data_type: string;
    /** For enum columns, ordered list of allowed values. Enables dropdown in table editor. */
    enum_labels?: string[] | null;
}

export interface ConnectionResponse {
    connection_id: string;
    database_name: string;
    /** Full version string, e.g. "PostgreSQL 16.4 on ..." */
    server_version: string;
    /** Numeric version, e.g. 160004 for PG 16.4 */
    pg_version_num: number;
}

/** Access profile for the currently connected DB role. */
export interface DatabaseAccessProfile {
    current_user: string;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    can_create_in_database: boolean;
    is_admin: boolean;
}

/** Extension metadata and install permission status. */
export interface DatabaseExtensionInfo {
    name: string;
    default_version: string | null;
    installed_version: string | null;
    comment: string | null;
    requires_superuser: boolean;
    trusted: boolean;
    can_install: boolean;
    install_block_reason: string | null;
}

/** Role metadata for RBAC assignment. */
export interface DatabaseRoleInfo {
    name: string;
    can_login: boolean;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    is_system_role: boolean;
    is_assignable: boolean;
}

/** One member attached to a role in RBAC detail views. */
export interface DatabaseRoleMemberInfo {
    name: string;
    can_login: boolean;
    is_superuser: boolean;
    is_system_role: boolean;
    admin_option: boolean;
}

/** Rich role metadata for membership management dialogs. */
export interface DatabaseRoleDetail {
    name: string;
    can_login: boolean;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    can_replicate: boolean;
    can_bypass_rls: boolean;
    inherit: boolean;
    valid_until: string | null;
    comment: string | null;
    is_system_role: boolean;
    is_assignable: boolean;
    can_grant_membership: boolean;
    can_revoke_membership: boolean;
    manage_block_reason: string | null;
    member_of: string[];
    members: DatabaseRoleMemberInfo[];
}

/** Database login account details. */
export interface DatabaseUserInfo {
    username: string;
    can_login: boolean;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    can_replicate: boolean;
    can_bypass_rls: boolean;
    is_system_role: boolean;
    valid_until: string | null;
    member_of: string[];
}

/** Detailed metadata for a selected extension. */
export interface DatabaseExtensionDetail {
    name: string;
    default_version: string | null;
    installed_version: string | null;
    installed_schema: string | null;
    installed_owner: string | null;
    comment: string | null;
    requires_superuser: boolean;
    trusted: boolean;
    available_versions: string[];
    can_install: boolean;
    can_uninstall: boolean;
    can_update: boolean;
    install_block_reason: string | null;
    uninstall_block_reason: string | null;
    update_block_reason: string | null;
}

/** Payload to create a database user via GUI. */
export interface CreateDatabaseUserRequest {
    username: string;
    password: string;
    role_memberships: string[];
    can_create_db: boolean;
    can_create_role: boolean;
    is_superuser: boolean;
    inherit: boolean;
    replication: boolean;
    bypass_rls: boolean;
    valid_until: string | null;
    password_reminder: string | null;
}

/** Payload to create a custom NOLOGIN role for RBAC memberships. */
export interface CreateDatabaseRoleRequest {
    role_name: string;
    inherit: boolean;
    memberships: string[];
}

/** Locally stored password reminder metadata (password itself is never stored). */
export interface PasswordReminder {
    id: string;
    username: string;
    reminder: string;
    created_at: number;
    updated_at: number;
}

/** Optional SSH tunnel config for connecting via a bastion. Sensitive: ssh_password only when save_ssh_password. */
export interface SshTunnelConfig {
    use_ssh_tunneling: boolean;
    tunnel_host: string;
    tunnel_port: number;
    username: string;
    authentication: "password" | "identity_file";
    identity_file_path?: string | null;
    /** Only set when save_ssh_password is true (sensitive). */
    ssh_password?: string | null;
    save_ssh_password?: boolean;
    keep_alive_seconds?: number;
}

/** Saved connection persisted in app data dir */
export interface SavedConnection {
    id: string;
    name: string;
    connection_string: string;
    database_name?: string | null;
    environment?: ConnectionEnvironment | null;
    owner?: string | null;
    criticality?: ConnectionCriticality | null;
    ssh_tunnel?: SshTunnelConfig | null;
}

export interface DesktopConnectedConnection {
    connection_id: string;
    database_name: string;
    server_version: string;
    host: string;
    port: number;
    user: string;
    is_active: boolean;
}

export interface DesktopQuickSearchContext {
    active_connection_id: string | null;
    connected_connections: DesktopConnectedConnection[];
}

export type BackupScope = "database" | "cluster";
export type BackupRecordStatus = "running" | "success" | "failed";
export type BackupCloudSyncStatus =
    | "not_configured"
    | "pending"
    | "synced"
    | "failed"
    | "skipped";

export interface BackupArtifact {
    id: string;
    label: string;
    kind: string;
    format: string;
    relative_path: string;
    absolute_path: string;
    bytes: number;
    database_name?: string | null;
    google_drive_file_id?: string | null;
}

export interface BackupRecord {
    id: string;
    name: string;
    scope: BackupScope;
    source_database?: string | null;
    connection_label: string;
    connection_string: string;
    output_root: string;
    backup_dir: string;
    status: BackupRecordStatus;
    started_at: number;
    completed_at?: number | null;
    bytes_written: number;
    estimated_bytes?: number | null;
    message?: string | null;
    error?: string | null;
    triggered_by: string;
    schedule_id?: string | null;
    artifacts: BackupArtifact[];
    server_version?: string | null;
    postgres_client_path?: string | null;
    postgres_client_version?: string | null;
    cloud_sync_status?: BackupCloudSyncStatus | null;
    cloud_sync_message?: string | null;
}

export interface BackupSchedule {
    id: string;
    name: string;
    enabled: boolean;
    cron: string;
    scope: BackupScope;
    source_database?: string | null;
    connection_label: string;
    connection_string: string;
    output_root: string;
    sync_to_google_drive: boolean;
    ssh_tunnel?: SshTunnelConfig | null;
    created_at: number;
    updated_at: number;
    next_run_at?: number | null;
    last_run_at?: number | null;
    last_status?: string | null;
    last_error?: string | null;
}

export interface BackupGoogleDriveStatus {
    enabled: boolean;
    configured: boolean;
    folder_id?: string | null;
    client_id?: string | null;
    connected_email?: string | null;
    connected_at?: number | null;
    access_token_expires_at?: number | null;
    has_refresh_token: boolean;
    has_access_token: boolean;
}

export interface BackupCapabilities {
    ready_for_backup: boolean;
    ready_for_restore: boolean;
    psql_path?: string | null;
    psql_version?: string | null;
    pg_dump_path?: string | null;
    pg_dump_version?: string | null;
    pg_restore_path?: string | null;
    pg_restore_version?: string | null;
    pg_dumpall_path?: string | null;
    pg_dumpall_version?: string | null;
    notes: string[];
}

export interface BackupModuleState {
    backups: BackupRecord[];
    schedules: BackupSchedule[];
    default_output_root: string;
    google_drive: BackupGoogleDriveStatus;
    capabilities: BackupCapabilities;
}

export interface BackupSizeEstimateItem {
    database_name: string;
    estimated_bytes: number;
}

export interface BackupSizeEstimate {
    scope: BackupScope;
    estimated_bytes: number;
    database_breakdown: BackupSizeEstimateItem[];
}

export interface BackupRunRequest {
    connection_id?: string | null;
    connection_label: string;
    connection_string: string;
    ssh_tunnel?: SshTunnelConfig | null;
    scope: BackupScope;
    source_database?: string | null;
    output_root?: string | null;
    sync_to_google_drive: boolean;
    name?: string | null;
    schedule_id?: string | null;
    estimated_bytes?: number | null;
}

export interface BackupRestoreRequest {
    backup_id: string;
    connection_string: string;
    ssh_tunnel?: SshTunnelConfig | null;
    target_database: string;
    source_database?: string | null;
    create_database_if_missing: boolean;
    clean_restore: boolean;
}

export interface BackupRestoreResult {
    backup_id: string;
    target_database: string;
    restored_artifact: string;
    message: string;
}

export interface BackupScheduleInput {
    id?: string | null;
    name: string;
    enabled: boolean;
    cron: string;
    scope: BackupScope;
    source_database?: string | null;
    connection_label: string;
    connection_string: string;
    output_root?: string | null;
    sync_to_google_drive: boolean;
    ssh_tunnel?: SshTunnelConfig | null;
}

export interface BackupProgressPayload {
    job_id: string;
    kind: "backup" | "restore" | string;
    phase: string;
    message: string;
    current: number;
    total: number;
    percent: number;
    bytes_written?: number | null;
    estimated_bytes?: number | null;
    artifact_label?: string | null;
}

export interface BackupGoogleDriveConfigInput {
    enabled: boolean;
    folder_id?: string | null;
    client_id?: string | null;
    refresh_token?: string | null;
    access_token?: string | null;
    connected_email?: string | null;
    connected_at?: number | null;
    access_token_expires_at?: number | null;
}

/** Event trigger (database level, PG 9.3+) */
export interface EventTriggerInfo {
    name: string;
    /** ddl_command_start | ddl_command_end | sql_drop | table_rewrite */
    event: string;
    /** origin | disabled | replica | always */
    enabled: string;
    /** Name of the trigger function */
    function_name: string;
}

/** Function, procedure, aggregate, or window function in a schema */
export interface FunctionInfo {
    name: string;
    arguments: string;
    return_type: string;
    is_trigger_function: boolean;
    /** function | procedure | aggregate | window */
    kind: string;
    /** Procedural language: plpgsql, sql, c, internal, … */
    language: string;
    security_definer: boolean;
    is_strict: boolean;
}

/** User-defined type in a schema */
export interface TypeInfo {
    name: string;
    /** enum | composite | domain | range | multirange */
    kind: string;
}

/** Column definition for CREATE TABLE (UI + data plane JSON). */
export interface CreateColumnDef {
    name: string;
    /** Base PostgreSQL type, e.g. "varchar", "integer", "numeric" */
    data_type: string;
    /** Optional length/precision, e.g. "255" or "10,2" */
    length?: string | null;
    is_nullable: boolean;
    default_value?: string | null;
    is_primary_key: boolean;
    is_unique: boolean;
    check_constraint?: string | null;
}

/** Type definition detail for preview (from db_get_type_definition) */
export interface TypeDefinitionDetail {
    schema: string;
    name: string;
    kind: string;
    enum_labels: string[] | null;
    composite_attrs: [string, string][] | null;
    domain_base_type: string | null;
    domain_check: string | null;
    range_subtype: string | null;
}

/** Table constraint (primary key, foreign key, unique, check) */
export interface TableConstraint {
    name: string;
    /** p = primary key, f = foreign key, u = unique, c = check, x = exclusion */
    constraint_type: string;
    columns: string[];
    foreign_table: string | null;
    foreign_columns: string[] | null;
    check_clause: string | null;
}

/** Table index */
export interface TableIndex {
    name: string;
    is_unique: boolean;
    is_primary: boolean;
    index_type: string;
    columns: string[];
    definition: string;
    comment: string | null;
}

/** Table trigger */
export interface TableTriggerInfo {
    name: string;
    timing: string;
    events: string[];
    function_name: string;
    enabled: boolean;
}

/** Full table details returned by db_get_table_details */
export interface TableDetails {
    schema: string;
    name: string;
    table_type: string;
    columns: ColumnInfo[];
    constraints: TableConstraint[];
    indexes: TableIndex[];
    triggers: TableTriggerInfo[];
    row_count: number;
    total_size: string;
    table_size: string;
    indexes_size: string;
    comment: string | null;
}

/** Documentation context for one table object. */
export interface DocumentationTable {
    schema: string;
    table: string;
    table_type: string;
    comment: string | null;
}

/** Documentation context for one column object. */
export interface DocumentationColumn {
    schema: string;
    table: string;
    table_type: string;
    ordinal_position: number;
    name: string;
    data_type: string;
    is_nullable: boolean;
    column_default: string | null;
    is_primary_key: boolean;
    foreign_key_target: string | null;
    comment: string | null;
}

/** Documentation context for one index object. */
export interface DocumentationIndex {
    schema: string;
    table: string;
    table_type: string;
    name: string;
    is_unique: boolean;
    is_primary: boolean;
    index_type: string;
    columns: string[];
    definition: string;
    comment: string | null;
}

/** Full documentation context payload for AI comment generation. */
export interface DocumentationContext {
    database_name: string;
    tables: DocumentationTable[];
    columns: DocumentationColumn[];
    indexes: DocumentationIndex[];
    undocumented_tables: number;
    undocumented_columns: number;
    undocumented_indexes: number;
}

/** One comment patch to apply with COMMENT ON. */
export interface DocumentationCommentPatch {
    kind: "table" | "column" | "index";
    schema: string;
    table?: string | null;
    column?: string | null;
    index?: string | null;
    comment: string;
}

/** Sidebar selection for the preview panel */
export type PreviewSelection =
    | { kind: "table"; schema: string; name: string }
    | { kind: "view"; schema: string; name: string }
    | { kind: "function"; schema: string; name: string; arguments: string; is_trigger_function?: boolean }
    | { kind: "type"; schema: string; name: string }
    | { kind: "event_trigger"; name: string };

/** Statistics for a single column (returned by db_get_column_stats) */
export interface ColumnStats {
    column: string;
    total_rows: number;
    null_count: number;
    non_null_count: number;
    distinct_count: number;
    null_pct: number;
    min_value: string | null;
    max_value: string | null;
    avg_value: number | null;
    /** Top 5 most frequent [value, count] pairs */
    top_values: [string, number][];
}

/** One condition in a multi-field filter query */
export interface FilterCondition {
    column: string;
    /** Whitelisted: =  !=  >  <  >=  <=  LIKE  NOT LIKE  ILIKE  NOT ILIKE  IS NULL  IS NOT NULL */
    operator: string;
    /** null for IS NULL / IS NOT NULL */
    value: string | null;
    /** "AND" | "OR" — joins this condition with the one before it */
    logical_op: string;
}

/** Status of the local (machine-installed) PostgreSQL server */
export interface LocalPostgresStatus {
    installed: boolean;
    running: boolean;
    version: string | null;
    data_dir: string | null;
    port: number;
    host: string;
    connection_string: string | null;
    /** "brew" | "apt" | "dnf" | "yum" | "pacman" | "system" | "windows" | null */
    install_method: string | null;
}

/** Progress event payload emitted during PostgreSQL installation */
export interface InstallProgress {
    percent: number;
    message: string;
    log: string | null;
}

/** A live PostgreSQL session row from pg_stat_activity */
export interface PgSession {
    pid: number;
    usename: string | null;
    application_name: string | null;
    datname: string | null;
    client_addr: string | null;
    client_port: number | null;
    backend_start: string | null;
    xact_start: string | null;
    query_start: string | null;
    state_change: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    state: string | null;
    query: string | null;
    backend_type: string | null;
    blocking_pids: number[];
    query_duration_secs: number | null;
    xact_duration_secs: number | null;
    backend_duration_secs: number | null;
}

/** Extract a displayable string from a CellValue */
export function formatCellValue(cell: CellValue): string {
    if (cell.type === "Null") return "NULL";
    if (cell.type === "Bool") return cell.value ? "true" : "false";
    if (cell.type === "Json") return JSON.stringify(cell.value);
    if (cell.type === "Bytes") return `[${(cell.value as number[]).length} bytes]`;
    return String(cell.value ?? "");
}

// ── Live Table Watcher ─────────────────────────────────────────────────────

/** Emitted by the Rust watcher for every INSERT / UPDATE / DELETE on a watched table. */
export interface TableWatchEvent {
    connection_id: string;
    schema: string;
    table: string;
    /** "INSERT" | "UPDATE" | "DELETE" */
    op: string;
    /** Full new row as a plain JSON object (column → value). Present on INSERT and UPDATE. */
    new_row: Record<string, unknown> | null;
    /** Full old row as a plain JSON object. Present on UPDATE and DELETE. */
    old_row: Record<string, unknown> | null;
    /** true when the row payload exceeded pg_notify's 8 kB limit — do a full refresh instead. */
    oversized: boolean;
}

/** Build the Tauri event name for a specific table watch — must match watcher.rs.
 *  Tauri only allows alphanumeric, `-`, `/`, `:`, `_` in event names. */
export function watchEventName(connectionId: string, schema: string, table: string): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9\-_]/g, "_");
    return `tw/${connectionId}/${safe(schema)}/${safe(table)}`;
}

/** Return a human-readable PG version label, e.g. "PostgreSQL 16" */
export function pgVersionLabel(versionNum: number): string {
    const major = Math.floor(versionNum / 10000);
    const minor = Math.floor((versionNum % 10000) / 100);
    return minor > 0 ? `PostgreSQL ${major}.${minor}` : `PostgreSQL ${major}`;
}

// ── Visual Index Builder ───────────────────────────────────────────────────

/** Index with live usage statistics from pg_stat_user_indexes */
export interface IndexStats {
    schema: string;
    table_name: string;
    index_name: string;
    is_unique: boolean;
    is_primary: boolean;
    /** Access method: btree, hash, gin, gist, brin, spgist */
    index_type: string;
    columns: string[];
    /** Full CREATE INDEX definition */
    definition: string;
    size_pretty: string;
    size_bytes: number;
    idx_scans: number;
    scans_per_day: number;
    is_unused: boolean;
    stats_reset: string | null;
}

/** Sample query from pg_stat_statements for a table (AI index optimization context) */
export interface QuerySample {
    query: string;
    calls: number;
    mean_exec_time_ms: number;
}

/** A query from pg_stat_statements that would benefit from a proposed index */
export interface IndexImpactQuery {
    query: string;
    calls: number;
    mean_exec_time_ms: number;
    total_exec_time_ms: number;
    estimated_time_after_ms: number;
    benefit_reason: string;
}

/** Live build progress from pg_stat_progress_create_index */
export interface IndexBuildProgress {
    index_name: string;
    phase: string;
    blocks_done: number;
    blocks_total: number;
    tuples_done: number;
    tuples_total: number;
    percent_done: number;
    is_complete: boolean;
}

/** Parameters for creating a new index */
export interface CreateIndexRequest {
    schema: string;
    table_name: string;
    /** Auto-generated as idx_{table}_{cols} if null */
    index_name: string | null;
    columns: string[];
    /** BTREE | HASH | GIN | GIST | BRIN | SPGIST */
    index_type: string;
    is_unique: boolean;
    where_clause: string | null;
}

/** Single column within a topology node (includes type + key info) */
export interface TopologyColumn {
    name: string;
    data_type: string;
    is_primary_key: boolean;
    is_nullable: boolean;
}

/** Table node for schema topology (ER diagram) */
export interface TopologyNode {
    schema: string;
    table_name: string;
    row_count: number;
    columns: TopologyColumn[];
}

/** Foreign key edge for schema topology */
export interface TopologyEdge {
    constraint_name: string;
    from_schema: string;
    from_table: string;
    from_column: string;
    to_schema: string;
    to_table: string;
    to_column: string;
}

/** Full topology: nodes + edges for one schema */
export interface TopologyData {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
}

/** Column metadata for ALTER TABLE impact previews. */
export interface AlterTablePreviewColumn {
    name: string;
    data_type: string;
    is_primary_key: boolean;
    is_nullable: boolean;
    status: "unchanged" | "added" | "removed" | "modified" | "renamed" | string;
    detail: string | null;
}

/** Table card used in the ALTER TABLE preview graph. */
export interface AlterTablePreviewNode {
    id: string;
    schema: string;
    table_name: string;
    row_count: number;
    role: "current" | "proposed" | "dependency" | "dependent" | "related" | string;
    note: string | null;
    columns: AlterTablePreviewColumn[];
}

/** Relationship edge used in the ALTER TABLE preview graph. */
export interface AlterTablePreviewEdge {
    id: string;
    constraint_name: string;
    from_node_id: string;
    from_column: string;
    to_node_id: string;
    to_column: string;
    phase: "current" | "proposed" | string;
    impact: "unchanged" | "added" | "removed" | "changed" | string;
}

/** Parsed ALTER TABLE change description. */
export interface AlterTableChange {
    kind: string;
    title: string;
    detail: string;
    column: string | null;
    next_column: string | null;
    destructive: boolean;
    impacts_data: boolean;
}

/** Risk finding generated for an ALTER TABLE preview. */
export interface AlterTableRisk {
    severity: "info" | "warn" | "block" | string;
    title: string;
    detail: string;
    mitigation: string | null;
}

/** Suggested safer alternative for an ALTER TABLE operation. */
export interface AlterTableAlternative {
    title: string;
    summary: string;
    sql: string;
    reason: string;
}

/** Summary metrics for an ALTER TABLE preview. */
export interface AlterTableImpactSummary {
    table_type: string;
    row_count: number;
    total_size: string;
    table_size: string;
    indexes_size: string;
    index_count: number;
    trigger_count: number;
    incoming_relations: number;
    outgoing_relations: number;
    operation_count: number;
    risk_level: "low" | "medium" | "high" | "critical" | string;
    risk_score: number;
}

/** Full payload for the interactive ALTER TABLE preview. */
export interface AlterTablePreview {
    focus_schema: string;
    focus_table: string;
    focus_schema_after: string;
    focus_table_after: string;
    summary: AlterTableImpactSummary;
    nodes: AlterTablePreviewNode[];
    edges: AlterTablePreviewEdge[];
    changes: AlterTableChange[];
    risks: AlterTableRisk[];
    alternatives: AlterTableAlternative[];
    warnings: string[];
}

// ── Query Notes ────────────────────────────────────────────────────────────

/** A saved SQL query note persisted via the Rust core engine */
export interface QueryNote {
    id: string;
    title: string;
    sql: string;
    created_at: string;
    updated_at: string;
    tags: string[];
}

// ── Database Replica Management ────────────────────────────────────────────

/** Replication mode for a replica */
export type ReplicationMode = "streaming" | "logical" | "cascading";

/** Current sync status of a replica */
export type ReplicaStatus = "active" | "syncing" | "failed" | "lagging" | "paused" | "unknown";

/** Health state of a replica connection */
export type ReplicaHealth = "healthy" | "degraded" | "critical" | "offline";

/** Automated failover configuration */
export interface FailoverConfig {
    enabled: boolean;
    /** Lag threshold in seconds before failover triggers */
    lag_threshold_secs: number;
    /** Seconds to wait before triggering failover */
    cooldown_secs: number;
    /** Notify-only mode — alerts but doesn't auto-promote */
    notify_only: boolean;
}

/** Scheduled replication check configuration */
export interface ReplicationSchedule {
    enabled: boolean;
    /** Cron-style interval label: "1m" | "5m" | "15m" | "30m" | "1h" */
    interval: string;
    /** Epoch ms of last scheduled check */
    last_check_at: number | null;
    /** Epoch ms of next scheduled check */
    next_check_at: number | null;
}

/** Alert notification settings for a replica */
export interface ReplicaAlertConfig {
    /** Alert when lag exceeds this many seconds */
    lag_alert_threshold_secs: number;
    /** Alert when replica has been offline for this many seconds */
    offline_alert_threshold_secs: number;
    /** Enable email notifications (placeholder for future integration) */
    email_alerts: boolean;
    /** Enable in-app toast notifications */
    in_app_alerts: boolean;
}

/** Auto-recovery settings */
export interface AutoRecoveryConfig {
    enabled: boolean;
    /** Max number of automatic reconnect attempts */
    max_retries: number;
    /** Seconds between reconnect attempts */
    retry_interval_secs: number;
}

/** Performance metrics snapshot for a replica */
export interface ReplicaMetrics {
    /** Replication lag in seconds */
    lag_secs: number | null;
    /** Replication lag in bytes */
    lag_bytes: number | null;
    /** Epoch ms of last successful sync */
    last_sync_at: number | null;
    /** Bytes sent per second (approximate) */
    bytes_per_sec: number | null;
    /** Average query latency on the replica in ms */
    avg_query_latency_ms: number | null;
    /** Number of queries executed on replica in last interval */
    queries_per_sec: number | null;
    /** Connection health (0–100) */
    connection_health_score: number;
    /** History of lag readings for sparkline chart [epoch_ms, lag_secs][] */
    lag_history: [number, number][];
}

/** RBAC permission flags for replica actions */
export interface ReplicaPermissions {
    can_create: boolean;
    can_delete: boolean;
    can_promote: boolean;
    can_pause: boolean;
    can_resume: boolean;
    can_configure: boolean;
    reason: string | null;
}

/** A single managed database replica */
export interface ReplicaInfo {
    id: string;
    name: string;
    host: string;
    port: number;
    /** Name of the database being replicated */
    database_name: string;
    /** Role/user used for replication connection */
    replication_slot: string | null;
    mode: ReplicationMode;
    status: ReplicaStatus;
    health: ReplicaHealth;
    metrics: ReplicaMetrics;
    failover: FailoverConfig;
    schedule: ReplicationSchedule;
    alerts: ReplicaAlertConfig;
    auto_recovery: AutoRecoveryConfig;
    /** Whether this replica is the primary target for reads */
    is_read_replica: boolean;
    /** ISO timestamp when this replica was added */
    created_at: string;
    /** ISO timestamp of last config change */
    updated_at: string;
    /** Free-form notes */
    notes: string | null;
}

/** Payload to create a new replica */
export interface CreateReplicaRequest {
    name: string;
    host: string;
    port: number;
    database_name: string;
    replication_user: string;
    replication_password: string;
    mode: ReplicationMode;
    is_read_replica: boolean;
    failover: FailoverConfig;
    schedule: ReplicationSchedule;
    alerts: ReplicaAlertConfig;
    auto_recovery: AutoRecoveryConfig;
    notes: string | null;
}

/** Summary of all replicas for the overview cards */
export interface ReplicaSummary {
    total: number;
    active: number;
    lagging: number;
    failed: number;
    paused: number;
    avg_lag_secs: number | null;
    max_lag_secs: number | null;
}

/** A single health check event in the audit log */
export interface ReplicaHealthEvent {
    id: string;
    replica_id: string;
    replica_name: string;
    event_type: "check" | "failover" | "recovery" | "alert" | "promotion" | "pause" | "resume" | "create" | "delete";
    status: "ok" | "warning" | "error" | "info";
    message: string;
    occurred_at: number;
}

// ── Schema Designer ────────────────────────────────────────────────────────

export interface ForeignKeyRef {
    target_table_id: string;
    target_column_id: string;
    on_delete?: ForeignKeyAction;
    on_update?: ForeignKeyAction;
}

export type ForeignKeyAction =
    | "NO ACTION"
    | "RESTRICT"
    | "CASCADE"
    | "SET NULL"
    | "SET DEFAULT";



export interface AISchemaReport {
    performance_score: number;
    scalability_rating: string;
    bottlenecks: string[];
    index_suggestions: string[];
    architecture_notes: string[];
    estimated_load: string;
    summary: string;
}

// ── Replication Monitor (Tauri replication_snapshot / Patroni) ───────────

export interface ReplicationReplicaRow {
    pid: number;
    usename: string;
    applicationName: string;
    clientAddr: string | null;
    clientPort: number | null;
    state: string;
    sentLsn: string | null;
    writeLsn: string | null;
    flushLsn: string | null;
    replayLsn: string | null;
    writeLagMs: number | null;
    flushLagMs: number | null;
    replayLagMs: number | null;
    syncState: string;
    syncPriority: number;
}

export interface ReplicationSlotRow {
    slotName: string;
    slotType: string;
    active: boolean;
    activePid: number | null;
    restartLsn: string | null;
    confirmedFlushLsn: string | null;
    walRetainedBytes: number | null;
    database: string | null;
    plugin: string | null;
}

export interface ReplicationSnapshot {
    capturedAtMs: number;
    primaryLsn: string;
    replicas: ReplicationReplicaRow[];
    slots: ReplicationSlotRow[];
    walRetainedTotalBytes: number;
    maxReplayLagMs: number | null;
    fetchWarning?: string | null;
    isInRecovery: boolean;
}

export interface PatroniNode {
    name: string;
    role: string;
    state: string;
    lag: number | null;
    timeline: number | null;
}

export interface PatroniCluster {
    scope: string;
    nodes: PatroniNode[];
    failoverPossible: boolean;
}

/** Row from `pg_publication` */
export interface ReplicationPublicationRow {
    name: string;
    allTables: boolean;
    pubInsert: boolean;
    pubUpdate: boolean;
    pubDelete: boolean;
    pubTruncate: boolean;
}

export interface CreateLogicalPublicationRequest {
    name: string;
    /** `allTables` or `schemas` */
    mode: "allTables" | "schemas";
    schemas?: string[];
}

/** Generated physical-standby snippets (password never included). */
export interface StandbyReplicationPlan {
    primaryConninfoLine: string;
    pgBasebackupExample: string;
    standbySignalNote: string;
    hints: string[];
}
