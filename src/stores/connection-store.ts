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
import { notifyNoInternetDetected } from "@/lib/network-errors";

type LoadStatus = "idle" | "loading" | "success" | "error";

const pendingTableLoads = new Map<string, Promise<void>>();
const pendingFunctionLoads = new Map<string, Promise<void>>();
const pendingTypeLoads = new Map<string, Promise<void>>();
let pendingEventTriggerLoad: Promise<void> | null = null;

function scopedKey(connectionId: string, schema: string): string {
    return `${connectionId}::${schema}`;
}

function clearPendingLoads() {
    pendingTableLoads.clear();
    pendingFunctionLoads.clear();
    pendingTypeLoads.clear();
    pendingEventTriggerLoad = null;
}

function mergeTablesForSchema(existing: TableInfo[], schema: string, next: TableInfo[]): TableInfo[] {
    const withoutSchema = existing.filter((table) => table.schema !== schema);
    return [...withoutSchema, ...next];
}

function cleanBackendError(error: unknown): string {
    return String(error).replace(/^[a-z_]+:\s*/i, "").trim() || "Request failed";
}

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
    if (msg.includes("network is unreachable") || msg.includes("internet disconnected")) {
        return "No internet connection. Reconnect and try again.";
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
    postConnectRedirectPending: boolean;
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
    eventTriggersStatus: LoadStatus;
    eventTriggersError: string | null;
    schemaFunctions: Record<string, FunctionInfo[]>;
    schemaFunctionsStatus: Record<string, LoadStatus>;
    schemaFunctionsError: Record<string, string | null>;
    schemaTypes: Record<string, TypeInfo[]>;
    schemaTypesStatus: Record<string, LoadStatus>;
    schemaTypesError: Record<string, string | null>;
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
    /** Refresh schemas, databases, and trigger table data refetch (e.g. Cmd+Shift+R). */
    refreshAll: () => Promise<void>;
    loadEventTriggers: (force?: boolean) => Promise<void>;
    loadSchemaFunctions: (schema: string, force?: boolean) => Promise<void>;
    loadSchemaTypes: (schema: string, force?: boolean) => Promise<void>;
    loadSchemaObjects: (schema: string, force?: boolean) => Promise<void>;
    setConnectionString: (s: string) => void;
    clearError: () => void;
    markPostConnectRedirectConsumed: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
    const syncSchemaObjectLoadingFlag = () => {
        set({ isLoadingSchemaObjects: pendingFunctionLoads.size > 0 || pendingTypeLoads.size > 0 });
    };

    const ensureTablesLoaded = async (connectionId: string, schema: string, force = false): Promise<void> => {
        const key = scopedKey(connectionId, schema);
        const alreadyLoaded = get().tables.some((table) => table.schema === schema);

        if (!force && alreadyLoaded) return;

        const pending = pendingTableLoads.get(key);
        if (!force && pending) {
            await pending;
            return;
        }

        set({ isLoadingTables: true });

        const request = dbListTables(connectionId, schema)
            .then((nextTables) => {
                if (get().connectionId !== connectionId) return;
                set((state) => ({
                    tables: mergeTablesForSchema(state.tables, schema, nextTables),
                }));
            })
            .catch(() => {
                // Keep stale table list on failure.
            })
            .finally(() => {
                pendingTableLoads.delete(key);
                set({ isLoadingTables: pendingTableLoads.size > 0 });
            });

        pendingTableLoads.set(key, request);
        await request;
    };

    const ensureSchemaFunctionsLoaded = async (schema: string, force = false): Promise<void> => {
        const { connectionId, schemaFunctionsStatus } = get();
        if (!connectionId) return;

        const key = scopedKey(connectionId, schema);
        if (!force && schemaFunctionsStatus[schema] === "success") return;

        const pending = pendingFunctionLoads.get(key);
        if (!force && pending) {
            await pending;
            return;
        }

        set((state) => ({
            schemaFunctionsStatus: { ...state.schemaFunctionsStatus, [schema]: "loading" },
            schemaFunctionsError: { ...state.schemaFunctionsError, [schema]: null },
        }));

        const request = dbListFunctions(connectionId, schema)
            .then((functions) => {
                if (get().connectionId !== connectionId) return;
                set((state) => ({
                    schemaFunctions: { ...state.schemaFunctions, [schema]: functions },
                    schemaFunctionsStatus: { ...state.schemaFunctionsStatus, [schema]: "success" },
                    schemaFunctionsError: { ...state.schemaFunctionsError, [schema]: null },
                }));
            })
            .catch((error) => {
                if (get().connectionId !== connectionId) return;
                set((state) => ({
                    schemaFunctionsStatus: { ...state.schemaFunctionsStatus, [schema]: "error" },
                    schemaFunctionsError: {
                        ...state.schemaFunctionsError,
                        [schema]: cleanBackendError(error),
                    },
                }));
            })
            .finally(() => {
                pendingFunctionLoads.delete(key);
                syncSchemaObjectLoadingFlag();
            });

        pendingFunctionLoads.set(key, request);
        syncSchemaObjectLoadingFlag();
        await request;
    };

    const ensureSchemaTypesLoaded = async (schema: string, force = false): Promise<void> => {
        const { connectionId, schemaTypesStatus } = get();
        if (!connectionId) return;

        const key = scopedKey(connectionId, schema);
        if (!force && schemaTypesStatus[schema] === "success") return;

        const pending = pendingTypeLoads.get(key);
        if (!force && pending) {
            await pending;
            return;
        }

        set((state) => ({
            schemaTypesStatus: { ...state.schemaTypesStatus, [schema]: "loading" },
            schemaTypesError: { ...state.schemaTypesError, [schema]: null },
        }));

        const request = dbListTypes(connectionId, schema)
            .then((types) => {
                if (get().connectionId !== connectionId) return;
                set((state) => ({
                    schemaTypes: { ...state.schemaTypes, [schema]: types },
                    schemaTypesStatus: { ...state.schemaTypesStatus, [schema]: "success" },
                    schemaTypesError: { ...state.schemaTypesError, [schema]: null },
                }));
            })
            .catch((error) => {
                if (get().connectionId !== connectionId) return;
                set((state) => ({
                    schemaTypesStatus: { ...state.schemaTypesStatus, [schema]: "error" },
                    schemaTypesError: {
                        ...state.schemaTypesError,
                        [schema]: cleanBackendError(error),
                    },
                }));
            })
            .finally(() => {
                pendingTypeLoads.delete(key);
                syncSchemaObjectLoadingFlag();
            });

        pendingTypeLoads.set(key, request);
        syncSchemaObjectLoadingFlag();
        await request;
    };

    return {
        connectionId: null,
        connectionString: "",
        databaseName: "",
        serverVersion: "",
        isConnected: false,
        postConnectRedirectPending: false,
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
        eventTriggersStatus: "idle",
        eventTriggersError: null,
        schemaFunctions: {},
        schemaFunctionsStatus: {},
        schemaFunctionsError: {},
        schemaTypes: {},
        schemaTypesStatus: {},
        schemaTypesError: {},
        isLoadingSchemaObjects: false,
        refreshTrigger: 0,
        isRefreshingAll: false,

        setConnectionString: (s) => set({ connectionString: s }),
        clearError: () => set({ connectionError: null }),
        markPostConnectRedirectConsumed: () => set({ postConnectRedirectPending: false }),

        connect: async (connectionString, savedConnectionId) => {
            clearPendingLoads();
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
                    postConnectRedirectPending: true,
                    isConnecting: false,
                    isLoadingSchemas: false,
                    schemas,
                    selectedSchema: defaultSchema,
                    tables,
                    selectedTable: null,
                    previewSelection: null,
                    expandedSchemas: expanded,
                    eventTriggers: [],
                    eventTriggersStatus: "idle",
                    eventTriggersError: null,
                    schemaFunctions: {},
                    schemaFunctionsStatus: {},
                    schemaFunctionsError: {},
                    schemaTypes: {},
                    schemaTypesStatus: {},
                    schemaTypesError: {},
                    isLoadingSchemaObjects: false,
                });

                // Update saved connection with database name for display
                if (savedConnectionId) {
                    updateSavedConnectionDatabaseName(
                        savedConnectionId,
                        response.database_name
                    ).catch(() => { });
                }

                // Load databases in background.
                dbListDatabases(response.connection_id)
                    .then((dbs) => {
                        if (get().connectionId === response.connection_id) {
                            set({ databases: dbs });
                        }
                    })
                    .catch(() => { });
            } catch (error) {
                notifyNoInternetDetected(error);
                set({
                    isConnecting: false,
                    isLoadingSchemas: false,
                    postConnectRedirectPending: false,
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

            clearPendingLoads();
            set({
                connectionId: null,
                isConnected: false,
                postConnectRedirectPending: false,
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
                eventTriggersStatus: "idle",
                eventTriggersError: null,
                schemaFunctions: {},
                schemaFunctionsStatus: {},
                schemaFunctionsError: {},
                schemaTypes: {},
                schemaTypesStatus: {},
                schemaTypesError: {},
                isLoadingSchemaObjects: false,
                connectionError: null,
            });
        },

        loadEventTriggers: async (force = false) => {
            const { connectionId, eventTriggersStatus } = get();
            if (!connectionId) return;
            if (!force && eventTriggersStatus === "success") return;

            if (!force && pendingEventTriggerLoad) {
                await pendingEventTriggerLoad;
                return;
            }

            set({ eventTriggersStatus: "loading", eventTriggersError: null });

            const request = dbListEventTriggers(connectionId)
                .then((list) => {
                    if (get().connectionId !== connectionId) return;
                    set({
                        eventTriggers: list,
                        eventTriggersStatus: "success",
                        eventTriggersError: null,
                    });
                })
                .catch((error) => {
                    if (get().connectionId !== connectionId) return;
                    set({
                        eventTriggersStatus: "error",
                        eventTriggersError: cleanBackendError(error),
                    });
                })
                .finally(() => {
                    pendingEventTriggerLoad = null;
                });

            pendingEventTriggerLoad = request;
            await request;
        },

        loadSchemaFunctions: async (schema, force = false) => {
            await ensureSchemaFunctionsLoaded(schema, force);
        },

        loadSchemaTypes: async (schema, force = false) => {
            await ensureSchemaTypesLoaded(schema, force);
        },

        loadSchemaObjects: async (schema, force = false) => {
            await Promise.all([
                ensureSchemaFunctionsLoaded(schema, force),
                ensureSchemaTypesLoaded(schema, force),
            ]);
        },

        switchDatabase: async (targetDatabase) => {
            const { connectionString, connectionId, databases } = get();
            if (!connectionString || !connectionId) return;

            // Don't switch if already on this DB
            if (get().databaseName === targetDatabase) return;

            clearPendingLoads();
            set({ isSwitchingDatabase: true, connectionError: null });
            try {
                // Disconnect old connection
                await dbDisconnect(connectionId).catch(() => { });

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
                    serverVersion: response.server_version,
                    isConnected: true,
                    postConnectRedirectPending: true,
                    isSwitchingDatabase: false,
                    isLoadingSchemas: false,
                    schemas,
                    selectedSchema: defaultSchema,
                    tables,
                    selectedTable: null,
                    previewSelection: null,
                    expandedSchemas: expanded,
                    databases,
                    eventTriggers: [],
                    eventTriggersStatus: "idle",
                    eventTriggersError: null,
                    schemaFunctions: {},
                    schemaFunctionsStatus: {},
                    schemaFunctionsError: {},
                    schemaTypes: {},
                    schemaTypesStatus: {},
                    schemaTypesError: {},
                    isLoadingSchemaObjects: false,
                });
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
                if (get().connectionId !== connectionId) return;
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
            if (get().connectionId === connectionId) {
                set({ databases: dbs });
            }
        },

        dropDatabase: async (name) => {
            const { connectionId } = get();
            if (!connectionId) throw new Error("Not connected");
            await dbDropDatabase(connectionId, name);
            const dbs = await dbListDatabases(connectionId);
            if (get().connectionId === connectionId) {
                set({ databases: dbs });
            }
        },

        selectSchema: async (schema) => {
            const { connectionId } = get();
            if (!connectionId) return;

            set((state) => {
                const expanded = new Set(state.expandedSchemas);
                expanded.add(schema);
                return {
                    selectedSchema: schema,
                    selectedTable: null,
                    expandedSchemas: expanded,
                };
            });

            await ensureTablesLoaded(connectionId, schema);
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
            const { expandedSchemas, connectionId } = get();
            const next = new Set(expandedSchemas);

            if (next.has(schema)) {
                next.delete(schema);
                set({ expandedSchemas: next });
                return;
            }

            next.add(schema);
            set({ expandedSchemas: next });

            if (connectionId) {
                ensureTablesLoaded(connectionId, schema)
                    .then(() => {
                        if (get().selectedSchema == null) {
                            set({ selectedSchema: schema });
                        }
                    })
                    .catch(() => {
                        // ignore schema table load errors here; caller can retry by re-expanding
                    });
            }
        },

        refreshSchemas: async () => {
            const { connectionId } = get();
            if (!connectionId) return;

            clearPendingLoads();
            set({
                isLoadingSchemas: true,
                tables: [],
                expandedSchemas: new Set(),
                eventTriggers: [],
                eventTriggersStatus: "idle",
                eventTriggersError: null,
                schemaFunctions: {},
                schemaFunctionsStatus: {},
                schemaFunctionsError: {},
                schemaTypes: {},
                schemaTypesStatus: {},
                schemaTypesError: {},
                isLoadingSchemaObjects: false,
            });
            try {
                const schemas = await dbRefreshCache(connectionId);
                if (get().connectionId !== connectionId) return;
                set({ schemas, isLoadingSchemas: false });

                const { selectedSchema } = get();
                if (selectedSchema) {
                    await ensureTablesLoaded(connectionId, selectedSchema, true);
                    if (get().connectionId !== connectionId) return;
                    set({
                        expandedSchemas: new Set([selectedSchema]),
                    });
                }
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
    };
});
