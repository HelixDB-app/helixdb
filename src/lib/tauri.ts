import { invoke } from "@tauri-apps/api/core";
import type {
    ConnectionResponse,
    ConnectionEnvironment,
    CreateDatabaseRoleRequest,
    CreateDatabaseUserRequest,
    SchemaInfo,
    TableInfo,
    TopologyData,
    ColumnInfo,
    QueryResult,
    RecentTableOpen,
    SavedConnection,
    DatabaseAccessProfile,
    DatabaseExtensionDetail,
    DatabaseExtensionInfo,
    DatabaseRoleInfo,
    DatabaseRoleDetail,
    DatabaseUserInfo,
    PasswordReminder,
    EventTriggerInfo,
    FunctionInfo,
    TypeInfo,
    TypeDefinitionDetail,
    TableDetails,
    DocumentationContext,
    DocumentationCommentPatch,
    LocalPostgresStatus,
    FilterCondition,
    ColumnStats,
    PgSession,
    IndexStats,
    QuerySample,
    IndexImpactQuery,
    IndexBuildProgress,
    CreateIndexRequest,
    QueryNote,
    QueryHistoryFilter,
    QueryHistoryListResponse,
    QueryHistoryDetail,
    QueryHistoryDashboard,
    QueryHistoryDashboardFilter,
    PgStatStatementsStatus,
    PgStatStatementsFilter,
    PgStatStatementsPage,
} from "./types";
import type { ExportRequest, ExportResult } from "./export-types";

/** Connect to a PostgreSQL database. Pass optional connectionId (e.g. saved connection id) to reuse it. */
export async function dbConnect(
    connectionString: string,
    connectionId?: string | null
): Promise<ConnectionResponse> {
    return invoke<ConnectionResponse>("db_connect", {
        connectionString,
        connectionId: connectionId ?? undefined,
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

/** List recently opened tables/views for one connection */
export async function dbListRecentTables(
    connectionId: string,
    limit = 8
): Promise<RecentTableOpen[]> {
    return invoke<RecentTableOpen[]>("db_list_recent_tables", {
        connectionId,
        limit,
    });
}

/** Record one table/view open action and get the latest recent list */
export async function dbTrackRecentTableOpen(
    connectionId: string,
    schema: string,
    table: string,
    tableType: "BASE TABLE" | "VIEW"
): Promise<RecentTableOpen[]> {
    return invoke<RecentTableOpen[]>("db_track_recent_table_open", {
        connectionId,
        schema,
        table,
        tableType,
    });
}

/** Get schema topology (nodes + FK edges) for ER diagram */
export async function dbGetSchemaTopology(
    connectionId: string,
    schema: string
): Promise<TopologyData> {
    return invoke<TopologyData>("db_get_schema_topology", {
        connectionId,
        schema,
    });
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

/** Get complete metadata context for AI documentation generation. */
export async function dbGetDocumentationContext(
    connectionId: string,
    schema?: string | null
): Promise<DocumentationContext> {
    return invoke<DocumentationContext>("db_get_documentation_context", {
        connectionId,
        schema: schema ?? null,
    });
}

/** Apply COMMENT ON statements in one transaction. Returns applied count. */
export async function dbApplyDocumentationComments(
    connectionId: string,
    patches: DocumentationCommentPatch[]
): Promise<number> {
    return invoke<number>("db_apply_documentation_comments", {
        connectionId,
        patches,
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

/** Get table data with geometry columns as GeoJSON for map view */
export async function dbGetTableDataGeojson(
    connectionId: string,
    schema: string,
    table: string,
    geometryColumnNames: string[],
    limit: number
): Promise<QueryResult> {
    return invoke<QueryResult>("db_get_table_data_geojson", {
        connectionId,
        schema,
        table,
        geometryColumnNames,
        limit,
    });
}

/** Execute a raw SQL query */
export interface DbExecuteQueryOptions {
    environment?: ConnectionEnvironment | null;
    guardReason?: string | null;
}

export async function dbExecuteQuery(
    connectionId: string,
    sql: string,
    options?: DbExecuteQueryOptions
): Promise<QueryResult> {
    return invoke<QueryResult>("db_execute_query", {
        connectionId,
        sql,
        environment: options?.environment ?? null,
        guardReason: options?.guardReason ?? null,
    });
}

/** Export database to SQL file. Progress via "db-export-progress" event. */
export async function dbExportSql(
    request: ExportRequest
): Promise<ExportResult> {
    return invoke<ExportResult>("db_export_sql", { request });
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

/** Access profile for the current DB role */
export async function dbGetAccessProfile(
    connectionId: string
): Promise<DatabaseAccessProfile> {
    return invoke<DatabaseAccessProfile>("db_get_access_profile", { connectionId });
}

/** List available extensions with install permission metadata */
export async function dbListExtensions(
    connectionId: string
): Promise<DatabaseExtensionInfo[]> {
    return invoke<DatabaseExtensionInfo[]>("db_list_extensions", { connectionId });
}

/** Install one extension if current role is permitted */
export async function dbInstallExtension(
    connectionId: string,
    extensionName: string
): Promise<void> {
    return invoke<void>("db_install_extension", { connectionId, extensionName });
}

/** Load one extension detail (versions, owner, action permissions) */
export async function dbGetExtensionDetail(
    connectionId: string,
    extensionName: string
): Promise<DatabaseExtensionDetail> {
    return invoke<DatabaseExtensionDetail>("db_get_extension_detail", {
        connectionId,
        extensionName,
    });
}

/** Uninstall an installed extension */
export async function dbUninstallExtension(
    connectionId: string,
    extensionName: string
): Promise<void> {
    return invoke<void>("db_uninstall_extension", { connectionId, extensionName });
}

/** Update an extension to latest/default or a target version */
export async function dbUpdateExtension(
    connectionId: string,
    extensionName: string,
    targetVersion?: string | null
): Promise<void> {
    return invoke<void>("db_update_extension", {
        connectionId,
        extensionName,
        targetVersion: targetVersion ?? null,
    });
}

/** List roles for RBAC management */
export async function dbListDatabaseRoles(
    connectionId: string
): Promise<DatabaseRoleInfo[]> {
    return invoke<DatabaseRoleInfo[]>("db_list_database_roles", { connectionId });
}

/** List login users and memberships */
export async function dbListDatabaseUsers(
    connectionId: string
): Promise<DatabaseUserInfo[]> {
    return invoke<DatabaseUserInfo[]>("db_list_database_users", { connectionId });
}

/** Create a custom NOLOGIN RBAC role */
export async function dbCreateDatabaseRole(
    connectionId: string,
    request: CreateDatabaseRoleRequest
): Promise<void> {
    return invoke<void>("db_create_database_role", { connectionId, request });
}

/** Load one role detail payload with member/member-of data */
export async function dbGetDatabaseRoleDetail(
    connectionId: string,
    roleName: string
): Promise<DatabaseRoleDetail> {
    return invoke<DatabaseRoleDetail>("db_get_database_role_detail", {
        connectionId,
        roleName,
    });
}

/** Grant role membership to a target user/role */
export async function dbGrantDatabaseRoleMembership(
    connectionId: string,
    roleName: string,
    memberName: string,
    withAdminOption = false
): Promise<void> {
    return invoke<void>("db_grant_database_role_membership", {
        connectionId,
        roleName,
        memberName,
        withAdminOption,
    });
}

/** Revoke role membership from a target user/role */
export async function dbRevokeDatabaseRoleMembership(
    connectionId: string,
    roleName: string,
    memberName: string
): Promise<void> {
    return invoke<void>("db_revoke_database_role_membership", {
        connectionId,
        roleName,
        memberName,
    });
}

/** Create a new database login user with optional role memberships */
export async function dbCreateDatabaseUser(
    connectionId: string,
    request: CreateDatabaseUserRequest
): Promise<void> {
    return invoke<void>("db_create_database_user", { connectionId, request });
}

/** Enable/disable login for a user role */
export async function dbSetDatabaseUserLogin(
    connectionId: string,
    username: string,
    canLogin: boolean
): Promise<void> {
    return invoke<void>("db_set_database_user_login", {
        connectionId,
        username,
        canLogin,
    });
}

/** Reset password for an existing user */
export async function dbSetDatabaseUserPassword(
    connectionId: string,
    username: string,
    password: string
): Promise<void> {
    return invoke<void>("db_set_database_user_password", {
        connectionId,
        username,
        password,
    });
}

/** Delete a database user role (optionally reassign owned objects first) */
export async function dbDeleteDatabaseUser(
    connectionId: string,
    username: string,
    reassignOwnedTo?: string | null
): Promise<void> {
    return invoke<void>("db_delete_database_user", {
        connectionId,
        username,
        reassignOwnedTo: reassignOwnedTo ?? null,
    });
}

/** List local password reminders for the current connection target */
export async function dbListPasswordReminders(
    connectionId: string
): Promise<PasswordReminder[]> {
    return invoke<PasswordReminder[]>("db_list_password_reminders", { connectionId });
}

/** Delete one local password reminder */
export async function dbDeletePasswordReminder(
    connectionId: string,
    id: string
): Promise<PasswordReminder[]> {
    return invoke<PasswordReminder[]>("db_delete_password_reminder", { connectionId, id });
}

/** Create a new database */
export async function dbCreateDatabase(
    connectionId: string,
    name: string
): Promise<void> {
    return invoke<void>("db_create_database", { connectionId, name });
}

/** Drop a database (cannot be the currently connected database) */
export async function dbDropDatabase(
    connectionId: string,
    name: string
): Promise<void> {
    return invoke<void>("db_drop_database", { connectionId, name });
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

/** Create a new enum type. Values must be non-empty. */
export async function dbCreateEnum(
    connectionId: string,
    schema: string,
    name: string,
    values: string[]
): Promise<void> {
    return invoke("db_create_enum", { connectionId, schema, name, values });
}

/** Alter enum: renames and additions in one transaction. */
export async function dbAlterEnumValues(
    connectionId: string,
    schema: string,
    name: string,
    renames: [string, string][],
    additions: [string, string | null][]
): Promise<void> {
    const additionsPayload = additions.map(([v, after]) => [v, after ?? null] as [string, string | null]);
    return invoke("db_alter_enum_values", {
        connectionId,
        schema,
        name,
        renames,
        additions: additionsPayload,
    });
}

/**
 * Multi-condition filter search with pagination and sort.
 * Each condition is { column, operator, value, logical_op }.
 */
export async function dbSearchTableDataMulti(
    connectionId: string,
    schema: string,
    table: string,
    conditions: FilterCondition[],
    limit: number,
    page: number,
    sortColumn?: string,
    sortDirection?: string
): Promise<QueryResult> {
    return invoke<QueryResult>("db_search_table_data_multi", {
        connectionId,
        schema,
        table,
        conditions,
        limit,
        page,
        sortColumn: sortColumn ?? null,
        sortDirection: sortDirection ?? "ASC",
    });
}

/** Structured filter search: SELECT * FROM schema.table WHERE col OP value LIMIT limit */
export async function dbSearchTableData(
    connectionId: string,
    schema: string,
    table: string,
    column: string,
    operator: string,
    value?: string | null,
    limit?: number
): Promise<QueryResult> {
    return invoke<QueryResult>("db_search_table_data", {
        connectionId,
        schema,
        table,
        column,
        operator,
        value: value ?? null,
        limit: limit ?? 200,
    });
}

/** Insert one table row. Only include columns to set; omit or null uses DEFAULT/NULL. Returns rows affected (1). */
export async function dbInsertTableRow(
    connectionId: string,
    schema: string,
    table: string,
    values: { column: string; value: string | null }[]
): Promise<number> {
    return invoke<number>("db_insert_table_row", {
        connectionId,
        schema,
        table,
        values: values.map(({ column, value }) => ({ column, value: value ?? null })),
    });
}

/** Insert multiple table rows in a single transaction. Returns total rows inserted. */
export async function dbInsertTableRowsBulk(
    connectionId: string,
    schema: string,
    table: string,
    rows: { column: string; value: string | null }[][]
): Promise<number> {
    return invoke<number>("db_insert_table_rows_bulk", {
        connectionId,
        schema,
        table,
        rows: rows.map((values) =>
            values.map(({ column, value }) => ({ column, value: value ?? null }))
        ),
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
        pkColumns,
        pkValues,
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
        pkColumns,
        rowsPkValues,
    });
}

// ─── Table Details & DDL ────────────────────────────────────────────────────

/** Get full table details: columns, constraints, indexes, triggers, stats */
export async function dbGetTableDetails(
    connectionId: string,
    schema: string,
    table: string
): Promise<TableDetails> {
    return invoke<TableDetails>("db_get_table_details", { connectionId, schema, table });
}

/** Rename a table */
export async function dbRenameTable(
    connectionId: string,
    schema: string,
    table: string,
    newName: string
): Promise<void> {
    return invoke<void>("db_rename_table", { connectionId, schema, table, newName });
}

/** Rename a column */
export async function dbRenameColumn(
    connectionId: string,
    schema: string,
    table: string,
    column: string,
    newName: string
): Promise<void> {
    return invoke<void>("db_rename_column", { connectionId, schema, table, column, newName });
}

/** Alter a column: change type, default, or nullability */
export async function dbAlterColumn(
    connectionId: string,
    schema: string,
    table: string,
    column: string,
    newType?: string | null,
    newDefault?: string | null,
    nullable?: boolean | null
): Promise<void> {
    return invoke<void>("db_alter_column", {
        connectionId, schema, table, column,
        newType: newType ?? null,
        newDefault: newDefault ?? null,
        nullable: nullable ?? null,
    });
}

/** Add a new column to a table */
export async function dbAddColumn(
    connectionId: string,
    schema: string,
    table: string,
    column: string,
    dataType: string,
    isNullable: boolean,
    defaultValue?: string | null
): Promise<void> {
    return invoke<void>("db_add_column", {
        connectionId, schema, table, column,
        dataType, isNullable,
        defaultValue: defaultValue ?? null,
    });
}

/** Drop a column */
export async function dbDropColumn(
    connectionId: string,
    schema: string,
    table: string,
    column: string
): Promise<void> {
    return invoke<void>("db_drop_column", { connectionId, schema, table, column });
}

/** Column definition for CREATE TABLE */
export interface CreateColumnDef {
    name: string;
    data_type: string;
    /** Optional length/precision, e.g. "255" or "10,2" */
    length?: string | null;
    is_nullable: boolean;
    default_value?: string | null;
    is_primary_key: boolean;
    is_unique: boolean;
    check_constraint?: string | null;
}

/**
 * Create a new table with specified columns.
 * Returns the generated CREATE TABLE SQL on success.
 */
export async function dbCreateTable(
    connectionId: string,
    schema: string,
    table: string,
    columns: CreateColumnDef[],
    ifNotExists: boolean
): Promise<string> {
    return invoke<string>("db_create_table", {
        connectionId,
        schema,
        table,
        columns,
        ifNotExists,
    });
}

/** Truncate a table (removes all rows, resets sequences) */
export async function dbTruncateTable(
    connectionId: string,
    schema: string,
    table: string
): Promise<void> {
    return invoke<void>("db_truncate_table", { connectionId, schema, table });
}

/** Drop a table */
export async function dbDropTable(
    connectionId: string,
    schema: string,
    table: string,
    cascade: boolean
): Promise<void> {
    return invoke<void>("db_drop_table", { connectionId, schema, table, cascade });
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

// ─── Local PostgreSQL ─────────────────────────────────────────────────────

/** Check if local PostgreSQL is installed and running */
export async function localPostgresCheck(): Promise<LocalPostgresStatus> {
    return invoke<LocalPostgresStatus>("local_postgres_check");
}

/** Start the local PostgreSQL service */
export async function localPostgresStart(): Promise<LocalPostgresStatus> {
    return invoke<LocalPostgresStatus>("local_postgres_start");
}

/** Stop the local PostgreSQL service */
export async function localPostgresStop(): Promise<LocalPostgresStatus> {
    return invoke<LocalPostgresStatus>("local_postgres_stop");
}

/** Restart the local PostgreSQL service */
export async function localPostgresRestart(): Promise<LocalPostgresStatus> {
    return invoke<LocalPostgresStatus>("local_postgres_restart");
}

/** Install PostgreSQL (streams progress via "local-postgres-install-progress" events) */
export async function localPostgresInstall(): Promise<LocalPostgresStatus> {
    return invoke<LocalPostgresStatus>("local_postgres_install");
}

// ─── Live Table Watcher ───────────────────────────────────────────────────

/** Start watching a table for INSERT / UPDATE / DELETE events via LISTEN/NOTIFY. */
export async function dbWatchTable(
    connectionId: string,
    schema: string,
    table: string
): Promise<void> {
    return invoke<void>("db_watch_table", { connectionId, schema, table });
}

/** Stop watching a table and drop the trigger from the database. */
export async function dbUnwatchTable(
    connectionId: string,
    schema: string,
    table: string
): Promise<void> {
    return invoke<void>("db_unwatch_table", { connectionId, schema, table });
}

/** Returns whether a table is currently being actively watched. */
export async function dbIsWatching(
    connectionId: string,
    schema: string,
    table: string
): Promise<boolean> {
    return invoke<boolean>("db_is_watching", { connectionId, schema, table });
}

// ─── Session Monitor ─────────────────────────────────────────────────────

/** Fetch all active sessions from pg_stat_activity */
export async function dbGetSessions(connectionId: string): Promise<PgSession[]> {
    return invoke<PgSession[]>("db_get_sessions", { connectionId });
}

/** Terminate a backend process by PID (SIGTERM) */
export async function dbTerminateBackend(connectionId: string, pid: number): Promise<boolean> {
    return invoke<boolean>("db_terminate_backend", { connectionId, pid });
}

/** Cancel the current query of a backend by PID (gentler SIGINT) */
export async function dbCancelBackend(connectionId: string, pid: number): Promise<boolean> {
    return invoke<boolean>("db_cancel_backend", { connectionId, pid });
}

// ─── Column Statistics ────────────────────────────────────────────────────

/** Fetch null%, distinct count, min, max, avg and top-5 frequent values for a column */
export async function dbGetColumnStats(
    connectionId: string,
    schema: string,
    table: string,
    column: string
): Promise<ColumnStats> {
    return invoke<ColumnStats>("db_get_column_stats", {
        connectionId,
        schema,
        table,
        column,
    });
}

/** Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) and return the raw JSON string */
export async function dbExplainQuery(
    connectionId: string,
    sql: string
): Promise<string> {
    return invoke<string>("db_explain_query", { connectionId, sql });
}

// ─── Smart Query Sandbox ──────────────────────────────────────────────────

export interface SandboxDiffRow {
    before: (string | null)[] | null;
    after: (string | null)[] | null;
}

export interface SandboxExecuteResult {
    rows_affected: number;
    diff_rows: SandboxDiffRow[];
    columns: string[];
    query_type: string;
    warnings: string[];
    missing_where: boolean;
    select_columns: string[];
    select_rows: (string | null)[][];
}

/** Open a dedicated sandbox connection and BEGIN a transaction. Returns sandbox_id. */
export async function dbSandboxBegin(connectionId: string): Promise<string> {
    return invoke<string>("db_sandbox_begin", { connectionId });
}

/** Execute SQL inside the open sandbox transaction and get the before/after diff. */
export async function dbSandboxExecute(
    sandboxId: string,
    sql: string
): Promise<SandboxExecuteResult> {
    return invoke<SandboxExecuteResult>("db_sandbox_execute", { sandboxId, sql });
}

/** COMMIT the sandbox transaction — changes become permanent. */
export async function dbSandboxCommit(sandboxId: string): Promise<void> {
    return invoke<void>("db_sandbox_commit", { sandboxId });
}

/** ROLLBACK the sandbox transaction — all changes are discarded. */
export async function dbSandboxRollback(sandboxId: string): Promise<void> {
    return invoke<void>("db_sandbox_rollback", { sandboxId });
}

/** Seconds since the sandbox transaction was opened. */
export async function dbSandboxElapsed(sandboxId: string): Promise<number> {
    return invoke<number>("db_sandbox_elapsed", { sandboxId });
}

// ─── Visual Index Builder ─────────────────────────────────────────────────

/** Check whether pg_stat_statements is available and queryable for this DB. */
export async function dbPgStatStatementsStatus(
    connectionId: string
): Promise<PgStatStatementsStatus> {
    return invoke<PgStatStatementsStatus>("db_pg_stat_statements_status", { connectionId });
}

/** Run CREATE EXTENSION IF NOT EXISTS pg_stat_statements and return updated status. */
export async function dbPgStatStatementsEnable(
    connectionId: string
): Promise<PgStatStatementsStatus> {
    return invoke<PgStatStatementsStatus>("db_pg_stat_statements_enable", { connectionId });
}

/** List statements from pg_stat_statements with server-side pagination. */
export async function dbPgStatStatementsList(
    connectionId: string,
    filter: PgStatStatementsFilter
): Promise<PgStatStatementsPage> {
    return invoke<PgStatStatementsPage>("db_pg_stat_statements_list", {
        connectionId,
        filter,
    });
}

/** Get all indexes in a schema with live usage stats from pg_stat_user_indexes. */
export async function dbGetIndexes(
    connectionId: string,
    schema: string
): Promise<IndexStats[]> {
    return invoke<IndexStats[]>("db_get_indexes", { connectionId, schema });
}

/** Get sample queries from pg_stat_statements that reference a table (for AI index optimization). */
export async function dbGetTableQuerySamples(
    connectionId: string,
    schema: string,
    table: string
): Promise<QuerySample[]> {
    return invoke<QuerySample[]>("db_get_table_query_samples", {
        connectionId,
        schema,
        table,
    });
}

/** Find queries in pg_stat_statements that would benefit from a proposed index. */
export async function dbGetIndexImpact(
    connectionId: string,
    schema: string,
    table: string,
    columns: string[],
    whereClause: string | null
): Promise<IndexImpactQuery[]> {
    return invoke<IndexImpactQuery[]>("db_get_index_impact", {
        connectionId,
        schema,
        table,
        columns,
        whereClause,
    });
}

/** Create an index CONCURRENTLY (no table locking). Returns the generated SQL. */
export async function dbCreateIndex(
    connectionId: string,
    request: CreateIndexRequest
): Promise<string> {
    return invoke<string>("db_create_index", { connectionId, request });
}

/** Drop an index CONCURRENTLY to avoid locking. */
export async function dbDropIndex(
    connectionId: string,
    schema: string,
    indexName: string
): Promise<boolean> {
    return invoke<boolean>("db_drop_index", { connectionId, schema, indexName });
}

/** Poll build progress for a CONCURRENTLY-building index. Returns null when complete. */
export async function dbGetIndexBuildProgress(
    connectionId: string,
    indexName: string
): Promise<IndexBuildProgress | null> {
    return invoke<IndexBuildProgress | null>("db_get_index_build_progress", {
        connectionId,
        indexName,
    });
}

// ─── Query History & Performance Intelligence ─────────────────────────────

/** List query history rows with filters, pagination, sort, and summary stats. */
export async function queryHistoryList(
    filter: QueryHistoryFilter
): Promise<QueryHistoryListResponse> {
    return invoke<QueryHistoryListResponse>("query_history_list", { filter });
}

/** Get full details for a single query history row. */
export async function queryHistoryGetDetail(id: number): Promise<QueryHistoryDetail> {
    return invoke<QueryHistoryDetail>("query_history_get_detail", { id });
}

/** Get dashboard aggregates (trend, top slow, volume, anomalies). */
export async function queryHistoryGetDashboard(
    filter: QueryHistoryDashboardFilter
): Promise<QueryHistoryDashboard> {
    return invoke<QueryHistoryDashboard>("query_history_get_dashboard", { filter });
}

/** Persist AI analysis JSON for a query row. */
export async function queryHistorySaveAiAnalysis(
    id: number,
    analysisJson: string
): Promise<void> {
    return invoke<void>("query_history_save_ai_analysis", { id, analysisJson });
}

/** Save explain JSON payload for a query row. */
export async function queryHistorySaveExplain(
    id: number,
    explainJson: string
): Promise<void> {
    return invoke<void>("query_history_save_explain", { id, explainJson });
}

/** Toggle bookmark on a query row. */
export async function queryHistoryToggleBookmark(
    id: number,
    bookmark: boolean
): Promise<void> {
    return invoke<void>("query_history_toggle_bookmark", { id, bookmark });
}

/** Save/update note on a query row. */
export async function queryHistorySaveNote(
    id: number,
    note: string | null
): Promise<void> {
    return invoke<void>("query_history_save_note", { id, note });
}

/** Export filtered query history as CSV text. */
export async function queryHistoryExportCsv(
    filter: QueryHistoryFilter
): Promise<string> {
    return invoke<string>("query_history_export_csv", { filter });
}

/** Open a path in the system file manager (e.g. reveal file's parent folder in Finder). */
export async function openPath(path: string): Promise<void> {
    return invoke<void>("open_path", { path });
}

/** Append a line to the app debug log (for TestFlight / support). */
export async function appLogWrite(message: string): Promise<void> {
    return invoke<void>("app_log_write", { message });
}

/** Return the path to the app debug log file. */
export async function appLogPath(): Promise<string> {
    return invoke<string>("app_log_path");
}

// ─── Query Notes (persisted via Rust core engine) ─────────────────────────

/** Load all saved notes from disk */
export async function notesLoadAll(): Promise<QueryNote[]> {
    return invoke<QueryNote[]>("notes_load_all");
}

/** Save or update a note. Returns the full updated notes list. */
export async function notesSave(note: QueryNote): Promise<QueryNote[]> {
    return invoke<QueryNote[]>("notes_save", { note });
}

/** Delete a note by ID. Returns the full updated notes list. */
export async function notesDelete(id: string): Promise<QueryNote[]> {
    return invoke<QueryNote[]>("notes_delete", { id });
}

/** Search notes by keyword (case-insensitive on title + sql). */
export async function notesSearch(query: string): Promise<QueryNote[]> {
    return invoke<QueryNote[]>("notes_search", { query });
}

// ─── Schema Designer (persisted via Rust core engine) ─────────────────────

import type { SchemaProject } from "./types";

/** Load all schema designer projects from disk */
export async function schemaDesignerLoadAll(): Promise<SchemaProject[]> {
    return invoke<SchemaProject[]>("schema_designer_load_all");
}

/** Get a single schema designer project by ID */
export async function schemaDesignerGetProject(id: string): Promise<SchemaProject | null> {
    return invoke<SchemaProject | null>("schema_designer_get_project", { id });
}

/** Save or update a schema designer project. Returns the full updated list. */
export async function schemaDesignerSaveProject(project: SchemaProject): Promise<SchemaProject[]> {
    return invoke<SchemaProject[]>("schema_designer_save_project", { project });
}

/** Delete a schema designer project by ID. Returns the full updated list. */
export async function schemaDesignerDeleteProject(id: string): Promise<SchemaProject[]> {
    return invoke<SchemaProject[]>("schema_designer_delete_project", { id });
}

// ─── Authentication ────────────────────────────────────────────────────────

export interface UserProfile {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    provider: string;
    createdAt: string;
}

/** Open the system browser at the pgstudio-web login page with a CSRF state nonce. */
export async function authOpenLogin(state: string): Promise<void> {
    return invoke<void>("auth_open_login", { state });
}

/** Open the system browser at any URL (e.g. the web profile page). */
export async function authOpenBrowser(url: string): Promise<void> {
    return invoke<void>("auth_open_url", { url });
}

/** Store a JWT in the OS keychain. */
export async function authStoreToken(token: string): Promise<void> {
    return invoke<void>("auth_store_token", { token });
}

/** Retrieve the stored JWT from the OS keychain. Returns null when not authenticated. */
export async function authGetToken(): Promise<string | null> {
    return invoke<string | null>("auth_get_token");
}

/** Delete the stored JWT (logout). */
export async function authDeleteToken(): Promise<void> {
    return invoke<void>("auth_delete_token");
}

/** Fetch the current user's profile from pgstudio-web using the stored token.
 *  Returns null when unauthenticated or when the session has expired. */
export async function authFetchProfile(): Promise<UserProfile | null> {
    return invoke<UserProfile | null>("auth_fetch_profile");
}

// ─── Plans & Checkout ─────────────────────────────────────────────────────────

export interface PlanInfo {
    id: string;
    name: string;
    slug: string;
    price: number;
    currency: string;
    durationDays: number;
    features: string[];
    discordAccess: string;
    isFeatured: boolean;
    promoTag?: string | null;
}

/** Fetch available subscription plans from pgstudio-web. */
export async function authFetchPlans(): Promise<PlanInfo[]> {
    return invoke<PlanInfo[]>("auth_fetch_plans");
}

/**
 * Create a Stripe Checkout Session for the given plan using the stored desktop JWT.
 * Returns the Stripe checkout URL to open in the browser.
 */
export async function authCreateCheckout(planId: string): Promise<string> {
    return invoke<string>("auth_create_checkout", { planId });
}

// ─── Subscription ──────────────────────────────────────────────────────────

export interface SubscriptionStatus {
    id: string;
    planName: string;
    planSlug: string;
    status: "active" | "expired" | "cancelled" | "pending";
    discordAccess: string;
    startDate: string;
    endDate: string;
    paymentAmount: number;
    paymentCurrency: string;
    cancelledAt?: string;
}

/** Fetch the current user's subscription status from pgstudio-web.
 *  Returns null when unauthenticated or no active subscription. */
export async function subscriptionFetchStatus(): Promise<SubscriptionStatus | null> {
    return invoke<SubscriptionStatus | null>("subscription_fetch_status");
}

// ─── Trial ──────────────────────────────────────────────────────────────────

export interface TrialStatus {
    state: "active" | "expired" | "blocked";
    trialStartDate: string;
    trialExpiryDate: string;
    daysRemaining: number;
    trialUsed: boolean;
}

export interface TrialCheckResult {
    /** Whether the user may use the app without a paid subscription */
    allowed: boolean;
    trial: TrialStatus | null;
    trialDisabled: boolean;
    message: string;
}

/**
 * Initialize or re-check the device trial on app cold-start.
 * Registers the device with the backend on first call.
 */
export async function trialInit(associatedUserId?: string): Promise<TrialCheckResult> {
    return invoke<TrialCheckResult>("trial_init", {
        associatedUserId: associatedUserId ?? null,
    });
}

/** Lightweight periodic status check. */
export async function trialGetStatus(): Promise<TrialCheckResult> {
    return invoke<TrialCheckResult>("trial_get_status");
}

/** Associate the current device with a logged-in user after authentication. */
export async function trialAssociateUser(userId: string): Promise<TrialCheckResult> {
    return invoke<TrialCheckResult>("trial_associate_user", { userId });
}

/** Return the device fingerprint (64-char hex). */
export async function trialGetDeviceId(): Promise<string> {
    return invoke<string>("trial_get_device_id");
}

// ─── Schema Import ──────────────────────────────────────────────────────────
// NOTE: Tauri serializes Rust structs as snake_case by default

export interface ImportedTable {
    name: string;
    estimated_rows: number;
    comment: string | null;
    ddl: string;
}

export interface ImportedView {
    name: string;
    is_materialized: boolean;
    ddl: string;
}

export interface ImportedIndex {
    name: string;
    table_name: string;
    is_unique: boolean;
    is_primary: boolean;
    ddl: string;
}

export interface ImportedFunction {
    name: string;
    kind: string;
    arguments: string;
    return_type: string;
    ddl: string;
}

export interface ImportedTrigger {
    name: string;
    table_name: string;
    ddl: string;
}

export interface ImportedSequence {
    name: string;
    ddl: string;
}

export interface SchemaImportResult {
    schema: string;
    tables: ImportedTable[];
    views: ImportedView[];
    indexes: ImportedIndex[];
    functions: ImportedFunction[];
    triggers: ImportedTrigger[];
    sequences: ImportedSequence[];
}

export interface DbImportResult {
    database: string;
    schemas: SchemaImportResult[];
    total_tables: number;
    total_views: number;
    total_functions: number;
    total_indexes: number;
    total_triggers: number;
    total_sequences: number;
}

/**
 * Import all DDL (tables, views, functions, indexes, triggers, sequences)
 * from the connected database. Pass `schemas` to limit to specific schemas,
 * or an empty array to import all non-system schemas.
 */
export async function dbImportSchema(
    connectionId: string,
    schemas: string[] = []
): Promise<DbImportResult> {
    return invoke<DbImportResult>("db_import_schema", { connectionId, schemas });
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export interface GitFileStatus {
    path: string;
    status: "added" | "modified" | "deleted" | "untracked" | "renamed";
    staged: boolean;
    old_path: string | null;
}

export interface GitDiff {
    old_content: string;
    new_content: string;
    is_binary: boolean;
}

export interface GitBranch {
    name: string;
    is_current: boolean;
    is_remote: boolean;
    upstream: string | null;
    last_commit_message: string | null;
    last_commit_hash: string | null;
}

export interface GitCommit {
    hash: string;
    short_hash: string;
    message: string;
    author_name: string;
    author_email: string;
    date: string;
}

export interface GitRemoteInfo {
    remote_url: string | null;
    owner: string | null;
    repo: string | null;
    current_branch: string | null;
    ahead: number;
    behind: number;
}

export interface WorkspaceInfo {
    path: string;
    is_git_repo: boolean;
    current_branch: string | null;
    has_remote: boolean;
}

export interface GitWorkspace {
    id: string;
    path: string;
    remote_url: string | null;
    github_owner: string | null;
    github_repo: string | null;
    author_name: string | null;
    author_email: string | null;
    created_at: string;
    project_key: string | null;
    host_name: string | null;
    workspace_name: string | null;
    connection_scope: string | null;
    updated_at: string;
}

export interface GitWorkspaceBindingOptions {
    projectKey?: string | null;
    host?: string | null;
    workspaceName?: string | null;
    connectionId?: string | null;
}

export async function gitOpenWorkspace(
    path: string,
    binding?: GitWorkspaceBindingOptions
): Promise<WorkspaceInfo> {
    return invoke<WorkspaceInfo>("git_open_workspace", {
        path,
        projectKey: binding?.projectKey ?? null,
        host: binding?.host ?? null,
        workspaceName: binding?.workspaceName ?? null,
        connectionId: binding?.connectionId ?? null,
    });
}

/** Get or create a Git workspace for the given DB connection (stored under app data). No folder picker. */
export async function gitEnsureWorkspaceForConnection(
    connectionId: string,
    binding?: Omit<GitWorkspaceBindingOptions, "connectionId">
): Promise<WorkspaceInfo> {
    return invoke<WorkspaceInfo>("git_ensure_workspace_for_connection", {
        connectionId,
        projectKey: binding?.projectKey ?? null,
        host: binding?.host ?? null,
        workspaceName: binding?.workspaceName ?? null,
    });
}

export async function gitSetWorkspace(path: string): Promise<WorkspaceInfo> {
    return invoke<WorkspaceInfo>("git_set_workspace", { path });
}

export async function gitGetStatus(): Promise<GitFileStatus[]> {
    return invoke<GitFileStatus[]>("git_get_status");
}

export async function gitGetDiff(path: string, staged: boolean): Promise<GitDiff> {
    return invoke<GitDiff>("git_get_diff", { path, staged });
}

export async function gitStageFiles(paths: string[]): Promise<void> {
    return invoke<void>("git_stage_files", { paths });
}

export async function gitStageAll(): Promise<void> {
    return invoke<void>("git_stage_all");
}

export async function gitUnstageFiles(paths: string[]): Promise<void> {
    return invoke<void>("git_unstage_files", { paths });
}

export async function gitCommit(
    message: string,
    authorName: string,
    authorEmail: string
): Promise<GitCommit> {
    return invoke<GitCommit>("git_commit", { message, authorName, authorEmail });
}

export async function gitPush(
    remoteName: string,
    branch: string,
    token: string
): Promise<void> {
    return invoke<void>("git_push", { remoteName, branch, token });
}

export async function gitFetchRemote(
    remoteName: string,
    token?: string | null
): Promise<void> {
    return invoke<void>("git_fetch_remote", { remoteName, token: token ?? null });
}

export async function gitSetRemote(remoteName: string, url: string): Promise<void> {
    return invoke<void>("git_set_remote", { remoteName, url });
}

export async function gitListBranches(): Promise<GitBranch[]> {
    return invoke<GitBranch[]>("git_list_branches");
}

export async function gitCreateBranch(name: string, fromRef: string): Promise<GitBranch> {
    return invoke<GitBranch>("git_create_branch", { name, fromRef });
}

export async function gitCheckoutBranch(name: string): Promise<void> {
    return invoke<void>("git_checkout_branch", { name });
}

export async function gitDeleteBranch(name: string): Promise<void> {
    return invoke<void>("git_delete_branch", { name });
}

export async function gitGetLog(limit: number): Promise<GitCommit[]> {
    return invoke<GitCommit[]>("git_get_log", { limit });
}

export async function gitGetRemoteInfo(): Promise<GitRemoteInfo> {
    return invoke<GitRemoteInfo>("git_get_remote_info");
}

export async function gitGetDiffSummary(): Promise<string> {
    return invoke<string>("git_get_diff_summary");
}

export async function gitDiscardChanges(path: string): Promise<void> {
    return invoke<void>("git_discard_changes", { path });
}

export async function writeWorkspaceFile(
    workspacePath: string,
    relativePath: string,
    content: string
): Promise<void> {
    return invoke<void>("write_workspace_file", {
        workspacePath,
        relativePath,
        content,
    });
}

export async function deleteWorkspaceFile(
    workspacePath: string,
    relativePath: string
): Promise<void> {
    return invoke<void>("delete_workspace_file", {
        workspacePath,
        relativePath,
    });
}

export async function syncIdeFilesToWorkspace(
    workspacePath: string,
    files: { path: string; content: string }[]
): Promise<void> {
    return invoke<void>("sync_ide_files_to_workspace", {
        workspacePath,
        files,
    });
}

// Git storage
export async function gitStorageListWorkspaces(): Promise<GitWorkspace[]> {
    return invoke<GitWorkspace[]>("git_storage_list_workspaces");
}

export async function gitStorageSaveWorkspace(path: string): Promise<GitWorkspace> {
    return invoke<GitWorkspace>("git_storage_save_workspace", { path });
}

export async function gitStorageDeleteWorkspace(path: string): Promise<void> {
    return invoke<void>("git_storage_delete_workspace", { path });
}

export async function gitStorageUpdateRemote(
    path: string,
    remoteUrl: string | null,
    githubOwner: string | null,
    githubRepo: string | null
): Promise<void> {
    return invoke<void>("git_storage_update_remote", { path, remoteUrl, githubOwner, githubRepo });
}

export async function gitStorageUpdateAuthor(
    path: string,
    authorName: string,
    authorEmail: string
): Promise<void> {
    return invoke<void>("git_storage_update_author", { path, authorName, authorEmail });
}

export async function gitStorageGetGithubToken(): Promise<string | null> {
    return invoke<string | null>("git_storage_get_github_token");
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export interface GithubUser {
    login: string;
    name: string | null;
    avatar_url: string;
    html_url: string;
    email: string | null;
}

export interface GithubRepo {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
    clone_url: string;
    ssh_url: string;
    private: boolean;
    description: string | null;
    default_branch: string;
}

export interface GithubPullRequest {
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    state: string;
    head_ref: string;
    base_ref: string;
}

export interface GithubCollaborator {
    login: string;
    avatar_url: string;
    html_url: string;
}

export interface GithubBranch {
    name: string;
    protected: boolean;
}

export async function githubStartOauth(): Promise<void> {
    return invoke<void>("github_start_oauth");
}

export async function githubExchangeCode(code: string): Promise<GithubUser> {
    return invoke<GithubUser>("github_exchange_code", { code });
}

export async function githubGetCurrentUser(): Promise<GithubUser | null> {
    return invoke<GithubUser | null>("github_get_current_user");
}

export async function githubGetToken(): Promise<string | null> {
    return invoke<string | null>("github_get_token");
}

export async function githubRevokeToken(): Promise<void> {
    return invoke<void>("github_revoke_token");
}

export async function githubListRepos(): Promise<GithubRepo[]> {
    return invoke<GithubRepo[]>("github_list_repos");
}

export async function githubCreateRepo(
    name: string,
    description: string | null,
    isPrivate: boolean
): Promise<GithubRepo> {
    return invoke<GithubRepo>("github_create_repo", { name, description, private: isPrivate });
}

export async function githubCreatePr(
    owner: string,
    repo: string,
    title: string,
    body: string | null,
    head: string,
    base: string,
    reviewers: string[]
): Promise<GithubPullRequest> {
    return invoke<GithubPullRequest>("github_create_pr", { owner, repo, title, body, head, base, reviewers });
}

export async function githubListCollaborators(
    owner: string,
    repo: string
): Promise<GithubCollaborator[]> {
    return invoke<GithubCollaborator[]>("github_list_collaborators", { owner, repo });
}

export async function githubListRemoteBranches(
    owner: string,
    repo: string
): Promise<GithubBranch[]> {
    return invoke<GithubBranch[]>("github_list_remote_branches", { owner, repo });
}
