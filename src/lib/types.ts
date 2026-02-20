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

/** Sidebar selection for the preview panel */
export type PreviewSelection =
    | { kind: "table"; schema: string; name: string }
    | { kind: "view"; schema: string; name: string }
    | { kind: "function"; schema: string; name: string; arguments: string }
    | { kind: "type"; schema: string; name: string }
    | { kind: "event_trigger"; name: string };

/** Extract a displayable string from a CellValue */
export function formatCellValue(cell: CellValue): string {
    if (cell.type === "Null") return "NULL";
    if (cell.type === "Bool") return cell.value ? "true" : "false";
    if (cell.type === "Json") return JSON.stringify(cell.value);
    if (cell.type === "Bytes") return `[${(cell.value as number[]).length} bytes]`;
    return String(cell.value ?? "");
}

/** Return a human-readable PG version label, e.g. "PostgreSQL 16" */
export function pgVersionLabel(versionNum: number): string {
    const major = Math.floor(versionNum / 10000);
    const minor = Math.floor((versionNum % 10000) / 100);
    return minor > 0 ? `PostgreSQL ${major}.${minor}` : `PostgreSQL ${major}`;
}
