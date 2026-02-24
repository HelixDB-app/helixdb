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

export interface ResultColumn {
    name: string;
    data_type: string;
}

export interface ConnectionResponse {
    connection_id: string;
    database_name: string;
    /** Full version string, e.g. "PostgreSQL 16.4 on ..." */
    server_version: string;
    /** Numeric version, e.g. 160004 for PG 16.4 */
    pg_version_num: number;
}

/** Saved connection persisted in app data dir */
export interface SavedConnection {
    id: string;
    name: string;
    connection_string: string;
    database_name?: string | null;
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

/** Sidebar selection for the preview panel */
export type PreviewSelection =
    | { kind: "table"; schema: string; name: string }
    | { kind: "view"; schema: string; name: string }
    | { kind: "function"; schema: string; name: string; arguments: string }
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

// ── Schema Designer ────────────────────────────────────────────────────────

export interface ForeignKeyRef {
    target_table_id: string;
    target_column_id: string;
}

export interface SchemaDesignerColumn {
    id: string;
    name: string;
    data_type: string;
    nullable: boolean;
    default_value: string | null;
    is_primary_key: boolean;
    foreign_key: ForeignKeyRef | null;
    /** Column has UNIQUE constraint */
    unique?: boolean;
}

export interface SchemaDesignerIndex {
    id: string;
    name: string;
    columns: string[];
    unique: boolean;
    method: string;
}

export interface TablePosition {
    x: number;
    y: number;
}

export interface SchemaDesignerTable {
    id: string;
    name: string;
    columns: SchemaDesignerColumn[];
    indexes: SchemaDesignerIndex[];
    position: TablePosition | null;
}

export interface SchemaSnapshot {
    id: string;
    label: string;
    timestamp: string;
    tables: SchemaDesignerTable[];
}

export interface SchemaProject {
    id: string;
    name: string;
    app_type: string;
    description: string;
    tables: SchemaDesignerTable[];
    version_history: SchemaSnapshot[];
    created_at: string;
    updated_at: string;
}

export interface AISchemaReport {
    performance_score: number;
    scalability_rating: string;
    bottlenecks: string[];
    index_suggestions: string[];
    architecture_notes: string[];
    estimated_load: string;
    summary: string;
}
