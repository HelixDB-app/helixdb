import { create } from "zustand";
import type {
    SchemaInfo,
    TableInfo,
    ConnectionResponse,
    EventTriggerInfo,
    FunctionInfo,
    TypeInfo,
    PreviewSelection,
} from "@/lib/types";
import {
    dbConnect,
    dbDisconnect,
    dbListSchemas,
    dbListTables,
    dbRefreshCache,
    dbListDatabases,
    dbCreateDatabase,
    dbDropDatabase,
    dbListEventTriggers,
    dbListFunctions,
    dbListTypes,
    updateSavedConnectionDatabaseName,
} from "@/lib/tauri";

/** Replace the database name in a postgres URI */
function replaceDatabase(connectionString: string, newDatabase: string): string {
    try {
        const url = new URL(connectionString);
        url.pathname = "/" + encodeURIComponent(newDatabase);
        return url.toString();
    } catch {
        // Fallback: regex for postgres://user:pass@host:port/dbname[?params]
        return connectionString.replace(
            /(postgres(?:ql)?:\/\/[^/]+\/)([^?#]*)(.*)/,
            (_, prefix, _db, suffix) => `${prefix}${encodeURIComponent(newDatabase)}${suffix}`
        );
    }
}

/** Parse raw Rust/backend error messages into user-friendly strings */
export function parseConnectionError(raw: string): string {
    const msg = raw.toLowerCase();

    // Strip Tauri invoke wrapper prefix like "db_connect: ..."
    const stripped = raw.replace(/^[a-z_]+:\s*/i, "").trim();

    if (msg.includes("invalid connection string") || msg.includes("parse error")) {
        return "Invalid connection string. Use format: postgres://user:password@host:5432/database";
    }
    if (msg.includes("password authentication failed") || msg.includes("authentication failed")) {
        return "Authentication failed. Check your username and password.";
    }
    if (msg.includes("connection refused") || msg.includes("could not connect to server")) {
        return "Connection refused. Make sure PostgreSQL is running on the specified host and port.";
    }
    if (msg.includes("database") && (msg.includes("does not exist") || msg.includes("not found"))) {
        return "Database not found. Verify the database name in your connection string.";
    }
    if (msg.includes("role") && msg.includes("does not exist")) {
        return "User/role not found. Check the username in your connection string.";
    }
    if (msg.includes("timeout")) {
        return "Connection timed out. The server may be unreachable or too slow to respond.";
    }
    if (msg.includes("no such host") || msg.includes("name or service not known") || msg.includes("nodename nor servname provided")) {
        return "Hostname not found. Check the host address in your connection string.";
    }
    if (msg.includes("ssl") || msg.includes("tls")) {
        return "SSL/TLS error. Try connecting without SSL, or check your SSL certificate configuration.";
    }
    if (msg.includes("too many connections")) {
        return "Server has too many connections. Try again later or increase the server's connection limit.";
    }
    if (msg.includes("health check failed")) {
        return "Connected but health check failed. The database may be starting up — try again in a moment.";
    }
    if (msg.includes("failed to create connection pool")) {
        return "Failed to create connection pool. Check your connection parameters.";
    }

    // Return a cleaned-up version of the original error
    return stripped || raw;
}

interface ConnectionState {
    connectionId: string | null;
    connectionString: string;
    databaseName: string;
    serverVersion: string;
    isConnected: boolean;
    isConnecting: boolean;
    connectionError: string | null;

    // Available databases on the server
    databases: string[];
    isLoadingDatabases: boolean;
    isSwitchingDatabase: boolean;

    schemas: SchemaInfo[];
    selectedSchema: string | null;
    tables: TableInfo[];
    selectedTable: string | null;
    /** Current sidebar selection for preview (table, view, function, type, event trigger) */
    previewSelection: PreviewSelection | null;
    isLoadingSchemas: boolean;
    isLoadingTables: boolean;

    expandedSchemas: Set<string>;

    eventTriggers: EventTriggerInfo[];
    schemaFunctions: Record<string, FunctionInfo[]>;
    schemaTypes: Record<string, TypeInfo[]>;
    isLoadingSchemaObjects: boolean;

    /** Incremented on refreshAll(); DataTable refetches when this changes. */
    refreshTrigger: number;
    isRefreshingAll: boolean;

    connect: (connectionString: string, savedConnectionId?: string) => Promise<void>;
    disconnect: () => Promise<void>;
    switchDatabase: (databaseName: string) => Promise<void>;
    refreshDatabases: () => Promise<void>;
    createDatabase: (name: string) => Promise<void>;
    dropDatabase: (name: string) => Promise<void>;
    selectSchema: (schema: string) => Promise<void>;
    selectTable: (schema: string, table: string) => void;
    /** Select any object for preview (table, view, function, type, event trigger) */
    selectPreview: (selection: PreviewSelection | null) => void;
    toggleSchema: (schema: string) => void;
    refreshSchemas: () => Promise<void>;
    /** Refresh schemas, databases, and trigger table data refetch (e.g. Cmd+R). */
    refreshAll: () => Promise<void>;
    loadEventTriggers: () => Promise<void>;
    loadSchemaObjects: (schema: string) => Promise<void>;
    setConnectionString: (s: string) => void;
    clearError: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
    connectionId: null,
    connectionString: "",
    databaseName: "",
    serverVersion: "",
    isConnected: false,
    isConnecting: false,
    connectionError: null,
    databases: [],
    isLoadingDatabases: false,
    isSwitchingDatabase: false,
    schemas: [],
    selectedSchema: null,
    tables: [],
    selectedTable: null,
    previewSelection: null,
    isLoadingSchemas: false,
    isLoadingTables: false,
    expandedSchemas: new Set<string>(),
    eventTriggers: [],
    schemaFunctions: {},
    schemaTypes: {},
    isLoadingSchemaObjects: false,
    refreshTrigger: 0,
    isRefreshingAll: false,

    setConnectionString: (s) => set({ connectionString: s }),
    clearError: () => set({ connectionError: null }),

    connect: async (connectionString, savedConnectionId) => {
        set({ isConnecting: true, connectionError: null, connectionString });
        try {
            const response: ConnectionResponse = await dbConnect(connectionString);
            set({ isLoadingSchemas: true });
            const schemas = await dbListSchemas(response.connection_id);

            const publicSchema = schemas.find((s) => s.name === "public");
            const defaultSchema = publicSchema ? "public" : schemas[0]?.name ?? null;

            let tables: TableInfo[] = [];
            const expanded = new Set<string>();

            if (defaultSchema) {
                tables = await dbListTables(response.connection_id, defaultSchema);
                expanded.add(defaultSchema);
            }

            set({
                connectionId: response.connection_id,
                databaseName: response.database_name,
                serverVersion: response.server_version,
                isConnected: true,
                isConnecting: false,
                isLoadingSchemas: false,
                schemas,
                selectedSchema: defaultSchema,
                tables,
                expandedSchemas: expanded,
            });

            // Update saved connection with database name for display
            if (savedConnectionId) {
                updateSavedConnectionDatabaseName(
                    savedConnectionId,
                    response.database_name
                ).catch(() => {});
            }

            // Load databases and event triggers in background
            dbListDatabases(response.connection_id)
                .then((dbs) => set({ databases: dbs }))
                .catch(() => {});
            dbListEventTriggers(response.connection_id)
                .then((list) => set({ eventTriggers: list }))
                .catch(() => {});
            if (defaultSchema) {
                get().loadSchemaObjects(defaultSchema);
            }
        } catch (error) {
            set({
                isConnecting: false,
                isLoadingSchemas: false,
                connectionError: parseConnectionError(String(error)),
            });
        }
    },

    disconnect: async () => {
        const { connectionId } = get();
        if (connectionId) {
            try {
                await dbDisconnect(connectionId);
            } catch {
                // Ignore disconnect errors
            }
        }
        set({
            connectionId: null,
            isConnected: false,
            connectionString: "",
            databaseName: "",
            serverVersion: "",
            databases: [],
            schemas: [],
            selectedSchema: null,
            tables: [],
            selectedTable: null,
            previewSelection: null,
            expandedSchemas: new Set(),
            eventTriggers: [],
            schemaFunctions: {},
            schemaTypes: {},
            connectionError: null,
        });
    },

    loadEventTriggers: async () => {
        const { connectionId } = get();
        if (!connectionId) return;
        try {
            const list = await dbListEventTriggers(connectionId);
            set({ eventTriggers: list });
        } catch {}
    },

    loadSchemaObjects: async (schema) => {
        const { connectionId } = get();
        if (!connectionId) return;
        set({ isLoadingSchemaObjects: true });
        try {
            const [funcs, types] = await Promise.all([
                dbListFunctions(connectionId, schema),
                dbListTypes(connectionId, schema),
            ]);
            set((s) => ({
                schemaFunctions: { ...s.schemaFunctions, [schema]: funcs },
                schemaTypes: { ...s.schemaTypes, [schema]: types },
                isLoadingSchemaObjects: false,
            }));
        } catch {
            set({ isLoadingSchemaObjects: false });
        }
    },

    switchDatabase: async (targetDatabase) => {
        const { connectionString, connectionId, databases, serverVersion } = get();
        if (!connectionString || !connectionId) return;

        // Don't switch if already on this DB
        if (get().databaseName === targetDatabase) return;

        set({ isSwitchingDatabase: true, connectionError: null });
        try {
            // Disconnect old connection
            await dbDisconnect(connectionId).catch(() => {});

            // Build new connection string with target DB
            const newConnString = replaceDatabase(connectionString, targetDatabase);

            // Connect to the new database
            const response: ConnectionResponse = await dbConnect(newConnString);
            set({ isLoadingSchemas: true });
            const schemas = await dbListSchemas(response.connection_id);

            const publicSchema = schemas.find((s) => s.name === "public");
            const defaultSchema = publicSchema ? "public" : schemas[0]?.name ?? null;
            let tables: TableInfo[] = [];
            const expanded = new Set<string>();
            if (defaultSchema) {
                tables = await dbListTables(response.connection_id, defaultSchema);
                expanded.add(defaultSchema);
            }

            set({
                connectionId: response.connection_id,
                connectionString: newConnString,
                databaseName: response.database_name,
                serverVersion: serverVersion,
                isConnected: true,
                isSwitchingDatabase: false,
                isLoadingSchemas: false,
                schemas,
                selectedSchema: defaultSchema,
                tables,
                selectedTable: null,
                previewSelection: null,
                expandedSchemas: expanded,
                databases,
                schemaFunctions: {},
                schemaTypes: {},
            });
            dbListEventTriggers(response.connection_id)
                .then((list) => set({ eventTriggers: list }))
                .catch(() => {});
            if (defaultSchema) {
                get().loadSchemaObjects(defaultSchema);
            }
        } catch (error) {
            set({
                isSwitchingDatabase: false,
                isLoadingSchemas: false,
                connectionError: parseConnectionError(String(error)),
            });
        }
    },

    refreshDatabases: async () => {
        const { connectionId } = get();
        if (!connectionId) return;
        set({ isLoadingDatabases: true });
        try {
            const dbs = await dbListDatabases(connectionId);
            set({ databases: dbs, isLoadingDatabases: false });
        } catch {
            set({ isLoadingDatabases: false });
        }
    },

    createDatabase: async (name) => {
        const { connectionId } = get();
        if (!connectionId) throw new Error("Not connected");
        await dbCreateDatabase(connectionId, name);
        const dbs = await dbListDatabases(connectionId);
        set({ databases: dbs });
    },

    dropDatabase: async (name) => {
        const { connectionId } = get();
        if (!connectionId) throw new Error("Not connected");
        await dbDropDatabase(connectionId, name);
        const dbs = await dbListDatabases(connectionId);
        set({ databases: dbs });
    },

    selectSchema: async (schema) => {
        const { connectionId } = get();
        if (!connectionId) return;

        set({ selectedSchema: schema, isLoadingTables: true, selectedTable: null });
        try {
            const newTables = await dbListTables(connectionId, schema);
            const state = get();
            // Merge with tables from other schemas
            const otherTables = state.tables.filter((t) => t.schema !== schema);
            set({ tables: [...otherTables, ...newTables], isLoadingTables: false });
        } catch {
            set({ isLoadingTables: false });
        }
    },

    selectTable: (schema, table) => {
        const { tables } = get();
        const isView =
            tables.find((t) => t.schema === schema && t.name === table)?.table_type === "VIEW";
        set({
            selectedSchema: schema,
            selectedTable: table,
            previewSelection: {
                kind: isView ? "view" : "table",
                schema,
                name: table,
            },
        });
    },

    selectPreview: (selection) => {
        if (!selection) {
            set({ previewSelection: null, selectedTable: null });
            return;
        }
        if (selection.kind === "table" || selection.kind === "view") {
            set({
                previewSelection: selection,
                selectedSchema: selection.schema,
                selectedTable: selection.name,
            });
        } else {
            set({
                previewSelection: selection,
                selectedTable: null,
                ...(selection.kind === "function" || selection.kind === "type"
                    ? { selectedSchema: selection.schema }
                    : {}),
            });
        }
    },

    toggleSchema: (schema) => {
        const { expandedSchemas, connectionId, tables } = get();
        const next = new Set(expandedSchemas);

        if (next.has(schema)) {
            next.delete(schema);
            set({ expandedSchemas: next });
        } else {
            next.add(schema);
            set({ expandedSchemas: next });

            // Load tables and schema objects (functions, types) when expanding
            const alreadyLoaded = tables.some((t) => t.schema === schema);
            if (!alreadyLoaded && connectionId) {
                set({ isLoadingTables: true });
                dbListTables(connectionId, schema)
                    .then((newTables) => {
                        const state = get();
                        const otherTables = state.tables.filter((t) => t.schema !== schema);
                        set({
                            tables: [...otherTables, ...newTables],
                            isLoadingTables: false,
                            selectedSchema: state.selectedSchema ?? schema,
                        });
                    })
                    .catch(() => set({ isLoadingTables: false }));
            }
            get().loadSchemaObjects(schema);
        }
    },

    refreshSchemas: async () => {
        const { connectionId } = get();
        if (!connectionId) return;

        set({
            isLoadingSchemas: true,
            tables: [],
            expandedSchemas: new Set(),
            schemaFunctions: {},
            schemaTypes: {},
        });
        try {
            const schemas = await dbRefreshCache(connectionId);
            set({ schemas, isLoadingSchemas: false });

            const { selectedSchema } = get();
            if (selectedSchema) {
                const tables = await dbListTables(connectionId, selectedSchema);
                set({
                    tables,
                    expandedSchemas: new Set([selectedSchema]),
                });
                get().loadSchemaObjects(selectedSchema);
            }
            get().loadEventTriggers();
        } catch {
            set({ isLoadingSchemas: false });
        }
    },

    refreshAll: async () => {
        const { connectionId, refreshSchemas: doRefreshSchemas, refreshDatabases } = get();
        if (!connectionId) return;
        set({ isRefreshingAll: true, refreshTrigger: get().refreshTrigger + 1 });
        try {
            await Promise.all([doRefreshSchemas(), refreshDatabases()]);
        } finally {
            set({ isRefreshingAll: false });
        }
    },
}));
