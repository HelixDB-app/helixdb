import { invoke } from "@tauri-apps/api/core";
import type {
    ConnectionResponse,
    SchemaInfo,
    TableInfo,
    ColumnInfo,
    QueryResult,
    SavedConnection,
    EventTriggerInfo,
    FunctionInfo,
    TypeInfo,
    TypeDefinitionDetail,
} from "./types";

/** Connect to a PostgreSQL database */
export async function dbConnect(
    connectionString: string
): Promise<ConnectionResponse> {
    return invoke<ConnectionResponse>("db_connect", {
        connectionString,
    });
}

/** Disconnect from a database */
export async function dbDisconnect(connectionId: string): Promise<boolean> {
    return invoke<boolean>("db_disconnect", { connectionId });
}

/** List all schemas */
export async function dbListSchemas(
    connectionId: string
): Promise<SchemaInfo[]> {
    return invoke<SchemaInfo[]>("db_list_schemas", { connectionId });
}

/** List tables in a schema */
export async function dbListTables(
    connectionId: string,
    schema: string
): Promise<TableInfo[]> {
    return invoke<TableInfo[]>("db_list_tables", { connectionId, schema });
}

/** Get columns for a table */
export async function dbGetColumns(
    connectionId: string,
    schema: string,
    table: string
): Promise<ColumnInfo[]> {
    return invoke<ColumnInfo[]>("db_get_columns", {
        connectionId,
        schema,
        table,
    });
}

/** Get paginated table data */
export async function dbGetTableData(
    connectionId: string,
    schema: string,
    table: string,
    page: number,
    pageSize: number,
    sortColumn?: string,
    sortDirection?: string
): Promise<QueryResult> {
    return invoke<QueryResult>("db_get_table_data", {
        connectionId,
        schema,
        table,
        page,
        pageSize,
        sortColumn: sortColumn ?? null,
        sortDirection: sortDirection ?? null,
    });
}

/** Execute a raw SQL query */
export async function dbExecuteQuery(
    connectionId: string,
    sql: string
): Promise<QueryResult> {
    return invoke<QueryResult>("db_execute_query", { connectionId, sql });
}

/** Refresh the metadata cache */
export async function dbRefreshCache(
    connectionId: string
): Promise<SchemaInfo[]> {
    return invoke<SchemaInfo[]>("db_refresh_cache", { connectionId });
}

/** List all non-template databases on the server */
export async function dbListDatabases(
    connectionId: string
): Promise<string[]> {
    return invoke<string[]>("db_list_databases", { connectionId });
}

/** List event triggers (database level) */
export async function dbListEventTriggers(
    connectionId: string
): Promise<EventTriggerInfo[]> {
    return invoke<EventTriggerInfo[]>("db_list_event_triggers", { connectionId });
}

/** List functions and procedures in a schema */
export async function dbListFunctions(
    connectionId: string,
    schema: string
): Promise<FunctionInfo[]> {
    return invoke<FunctionInfo[]>("db_list_functions", { connectionId, schema });
}

/** List user-defined types in a schema */
export async function dbListTypes(
    connectionId: string,
    schema: string
): Promise<TypeInfo[]> {
    return invoke<TypeInfo[]>("db_list_types", { connectionId, schema });
}

/** Return the numeric PostgreSQL version for a live connection (e.g. 160004) */
export async function dbGetPgVersion(connectionId: string): Promise<number> {
    return invoke<number>("db_get_pg_version", { connectionId });
}

/** Get full CREATE FUNCTION/PROCEDURE source for preview */
export async function dbGetFunctionDefinition(
    connectionId: string,
    schema: string,
    name: string,
    args: string
): Promise<string | null> {
    return invoke<string | null>("db_get_function_definition", {
        connectionId,
        schema,
        name,
        arguments: args,
    });
}

/** Get type definition details for preview */
export async function dbGetTypeDefinition(
    connectionId: string,
    schema: string,
    name: string
): Promise<TypeDefinitionDetail | null> {
    return invoke<TypeDefinitionDetail | null>("db_get_type_definition", {
        connectionId,
        schema,
        name,
    });
}

/** Update one table row by primary key. Returns rows affected (0 or 1). */
export async function dbUpdateTableRow(
    connectionId: string,
    schema: string,
    table: string,
    pkColumns: string[],
    pkValues: (string | null)[],
    updates: { column: string; value: string | null }[]
): Promise<number> {
    return invoke<number>("db_update_table_row", {
        connectionId,
        schema,
        table,
        pk_columns: pkColumns,
        pk_values: pkValues,
        updates: updates.map(({ column, value }) => ({ column, value: value ?? null })),
    });
}

/** Delete table rows by primary key. Returns rows deleted. */
export async function dbDeleteTableRows(
    connectionId: string,
    schema: string,
    table: string,
    pkColumns: string[],
    rowsPkValues: (string | null)[][]
): Promise<number> {
    return invoke<number>("db_delete_table_rows", {
        connectionId,
        schema,
        table,
        pk_columns: pkColumns,
        rows_pk_values: rowsPkValues,
    });
}

/** Load saved connections from app data dir */
export async function getSavedConnections(): Promise<SavedConnection[]> {
    return invoke<SavedConnection[]>("get_saved_connections");
}

/** Save or update a connection */
export async function saveConnection(
    connection: SavedConnection
): Promise<SavedConnection[]> {
    return invoke<SavedConnection[]>("save_connection", { connection });
}

/** Delete a saved connection */
export async function deleteSavedConnection(
    id: string
): Promise<SavedConnection[]> {
    return invoke<SavedConnection[]>("delete_saved_connection", { id });
}

/** Update database_name for a saved connection (e.g. after first connect) */
export async function updateSavedConnectionDatabaseName(
    id: string,
    databaseName: string
): Promise<SavedConnection[]> {
    return invoke<SavedConnection[]>("update_saved_connection_database_name", {
        id,
        databaseName,
    });
}
