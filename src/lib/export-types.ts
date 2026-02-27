/** SQL export: what to include */
export type ExportContentType =
    | "structure_only"
    | "data_only"
    | "structure_and_data";

/** Schema.table reference for export */
export interface ExportTableRef {
    schema: string;
    table: string;
}

/** Request for db_export_sql. Keys match Rust (snake_case) for invoke. */
export interface ExportRequest {
    connection_id: string;
    schemas: string[];
    tables: ExportTableRef[];
    content_type: ExportContentType;
    compress: boolean;
    columns?: Record<string, string[]> | null;
    where_clause?: Record<string, string> | null;
    output_path?: string | null;
}

/** Result of successful export */
export interface ExportResult {
    output_path: string;
    bytes_written: number;
}

/** Progress event payload for db-export-progress */
export interface ExportProgressPayload {
    phase: string;
    message: string;
    current: number;
    total: number;
    table?: string;
    rows_exported?: number;
}
