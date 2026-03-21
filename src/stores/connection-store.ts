import { create } from "zustand";
import type {
    SchemaInfo,
    TableInfo,
    RecentTableOpen,
    ConnectionResponse,
    EventTriggerInfo,
    FunctionInfo,
    TypeInfo,
    PreviewSelection,
    ConnectionEnvironment,
    ConnectionCriticality,
    SshTunnelConfig,
} from "@/lib/types";
import {
    normalizeConnectionMetadata,
    type ConnectionMetadataInput,
} from "@/lib/connection-metadata";
import {
    dbConnect,
    dbDisconnect,
    dbListSchemas,
    dbListTables,
    dbRefreshCache,
} from "@/lib/db-platform";
import {
    dbListDatabases,
    dbCreateDatabase,
    dbDropDatabase,
    dbListEventTriggers,
    dbListFunctions,
    dbListTypes,
    dbListRecentTables,
    dbTrackRecentTableOpen,
    updateSavedConnectionDatabaseName,
} from "@/lib/tauri";
import { notifyNoInternetDetected } from "@/lib/network-errors";
import { track } from "@/lib/analytics";

type LoadStatus = "idle" | "loading" | "success" | "error";

export interface ConnectionEntry {
    connectionId: string;
    label: string;
    databaseName: string;
    serverVersion: string;
    connectionString: string;
    environment: ConnectionEnvironment;
    owner: string | null;
    criticality: ConnectionCriticality;
    savedConnectionId?: string;
}

export interface PerConnectionState {
    connectionString: string;
    databaseName: string;
    serverVersion: string;
    schemas: SchemaInfo[];
    selectedSchema: string | null;
    tables: TableInfo[];
    selectedTable: string | null;
    previewSelection: PreviewSelection | null;
    recentTables: RecentTableOpen[];
    expandedSchemas: Set<string>;
    databases: string[];
    isLoadingDatabases: boolean;
    isSwitchingDatabase: boolean;
    isLoadingSchemas: boolean;
    isLoadingTables: boolean;
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
}

function emptyPerConnectionState(connectionString: string, databaseName: string, serverVersion: string): PerConnectionState {
    return {
        connectionString,
        databaseName,
        serverVersion,
        schemas: [],
        selectedSchema: null,
        tables: [],
        selectedTable: null,
        previewSelection: null,
        recentTables: [],
        expandedSchemas: new Set(),
        databases: [],
        isLoadingDatabases: false,
        isSwitchingDatabase: false,
        isLoadingSchemas: false,
        isLoadingTables: false,
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
    };
}

const pendingTableLoads = new Map<string, Promise<void>>();
const pendingFunctionLoads = new Map<string, Promise<void>>();
const pendingTypeLoads = new Map<string, Promise<void>>();
const pendingEventTriggerLoads = new Map<string, Promise<void>>();

function scopedKey(connectionId: string, schema: string): string {
    return `${connectionId}::${schema}`;
}

function clearPendingLoadsForConnection(connectionId: string) {
    for (const key of pendingTableLoads.keys()) {
        if (key.startsWith(connectionId + "::")) pendingTableLoads.delete(key);
    }
    for (const key of pendingFunctionLoads.keys()) {
        if (key.startsWith(connectionId + "::")) pendingFunctionLoads.delete(key);
    }
    for (const key of pendingTypeLoads.keys()) {
        if (key.startsWith(connectionId + "::")) pendingTypeLoads.delete(key);
    }
    pendingEventTriggerLoads.delete(connectionId);
}

function clearAllPendingLoads() {
    pendingTableLoads.clear();
    pendingFunctionLoads.clear();
    pendingTypeLoads.clear();
    pendingEventTriggerLoads.clear();
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
        return connectionString.replace(
            /(postgres(?:ql)?:\/\/[^/]+\/)([^?#]*)(.*)/,
            (_, prefix, _db, suffix) => `${prefix}${encodeURIComponent(newDatabase)}${suffix}`
        );
    }
}

/** Parse raw Rust/backend error messages into user-friendly strings */
export function parseConnectionError(raw: string): string {
    const msg = raw.toLowerCase();
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
    return stripped || raw;
}

function syncCurrentFromActive(state: {
    activeConnectionId: string | null;
    connections: ConnectionEntry[];
    byConnectionId: Record<string, PerConnectionState>;
}): Partial<{
    connectionId: string | null;
    connectionString: string;
    databaseName: string;
    serverVersion: string;
    isConnected: boolean;
    schemas: SchemaInfo[];
    selectedSchema: string | null;
    tables: TableInfo[];
    selectedTable: string | null;
    previewSelection: PreviewSelection | null;
    recentTables: RecentTableOpen[];
    expandedSchemas: Set<string>;
    databases: string[];
    isLoadingDatabases: boolean;
    isSwitchingDatabase: boolean;
    isLoadingSchemas: boolean;
    isLoadingTables: boolean;
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
}> {
    const active = state.activeConnectionId;
    const entry = active ? state.connections.find((c) => c.connectionId === active) : null;
    const per = active ? state.byConnectionId[active] : null;
    const isConnected = state.connections.length > 0;
    if (!active || !entry || !per) {
        return {
            connectionId: null,
            connectionString: "",
            databaseName: "",
            serverVersion: "",
            isConnected,
            schemas: [],
            selectedSchema: null,
            tables: [],
            selectedTable: null,
            previewSelection: null,
            recentTables: [],
            expandedSchemas: new Set(),
            databases: [],
            isLoadingDatabases: false,
            isSwitchingDatabase: false,
            isLoadingSchemas: false,
            isLoadingTables: false,
            eventTriggers: [],
            eventTriggersStatus: "idle" as LoadStatus,
            eventTriggersError: null,
            schemaFunctions: {},
            schemaFunctionsStatus: {},
            schemaFunctionsError: {},
            schemaTypes: {},
            schemaTypesStatus: {},
            schemaTypesError: {},
            isLoadingSchemaObjects: false,
        };
    }
    return {
        connectionId: active,
        isConnected,
        connectionString: entry.connectionString,
        databaseName: entry.databaseName,
        serverVersion: entry.serverVersion,
        schemas: per.schemas,
        selectedSchema: per.selectedSchema,
        tables: per.tables,
        selectedTable: per.selectedTable,
        previewSelection: per.previewSelection,
        recentTables: per.recentTables,
        expandedSchemas: per.expandedSchemas,
        databases: per.databases,
        isLoadingDatabases: per.isLoadingDatabases,
        isSwitchingDatabase: per.isSwitchingDatabase,
        isLoadingSchemas: per.isLoadingSchemas,
        isLoadingTables: per.isLoadingTables,
        eventTriggers: per.eventTriggers,
        eventTriggersStatus: per.eventTriggersStatus,
        eventTriggersError: per.eventTriggersError,
        schemaFunctions: per.schemaFunctions,
        schemaFunctionsStatus: per.schemaFunctionsStatus,
        schemaFunctionsError: per.schemaFunctionsError,
        schemaTypes: per.schemaTypes,
        schemaTypesStatus: per.schemaTypesStatus,
        schemaTypesError: per.schemaTypesError,
        isLoadingSchemaObjects: per.isLoadingSchemaObjects,
    };
}

interface ConnectionState {
    connections: ConnectionEntry[];
    activeConnectionId: string | null;
    byConnectionId: Record<string, PerConnectionState>;

    // Mirrored from active connection for backward compatibility
    connectionId: string | null;
    connectionString: string;
    databaseName: string;
    serverVersion: string;
    isConnected: boolean;
    postConnectRedirectPending: boolean;
    isConnecting: boolean;
    connectionError: string | null;
    databases: string[];
    isLoadingDatabases: boolean;
    isSwitchingDatabase: boolean;
    schemas: SchemaInfo[];
    selectedSchema: string | null;
    tables: TableInfo[];
    selectedTable: string | null;
    previewSelection: PreviewSelection | null;
    recentTables: RecentTableOpen[];
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
    refreshTrigger: number;
    isRefreshingAll: boolean;

    connect: (
        connectionString: string,
        savedConnectionId?: string,
        savedLabel?: string,
        metadata?: ConnectionMetadataInput,
        sshTunnel?: SshTunnelConfig | null
    ) => Promise<void>;
    disconnect: (connectionId: string) => Promise<void>;
    setActiveConnection: (connectionId: string | null) => void;
    switchDatabase: (connectionId: string, databaseName: string) => Promise<void>;
    refreshDatabases: (connectionId?: string) => Promise<void>;
    createDatabase: (name: string, connectionId?: string) => Promise<void>;
    dropDatabase: (name: string, connectionId?: string) => Promise<void>;
    selectSchema: (schema: string, connectionId?: string) => Promise<void>;
    selectTable: (schema: string, table: string, connectionId?: string) => void;
    selectPreview: (selection: PreviewSelection | null, connectionId?: string) => void;
    toggleSchema: (schema: string, connectionId?: string) => void;
    refreshSchemas: (connectionId?: string) => Promise<void>;
    refreshAll: () => Promise<void>;
    loadEventTriggers: (connectionId?: string, force?: boolean) => Promise<void>;
    loadSchemaFunctions: (schema: string, connectionId?: string, force?: boolean) => Promise<void>;
    loadSchemaTypes: (schema: string, connectionId?: string, force?: boolean) => Promise<void>;
    loadSchemaObjects: (schema: string, connectionId?: string, force?: boolean) => Promise<void>;
    loadRecentTables: (connectionId?: string, limit?: number) => Promise<void>;
    setConnectionString: (s: string) => void;
    clearError: () => void;
    markPostConnectRedirectConsumed: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
    const syncCurrent = () => {
        const state = get();
        set(syncCurrentFromActive(state));
    };

    const setRecentTablesForConnection = (connectionId: string, recentTables: RecentTableOpen[]) => {
        set((s) => {
            const per = s.byConnectionId[connectionId];
            if (!per) return s;
            const next = { ...per, recentTables };
            const out: Partial<ConnectionState> = {
                byConnectionId: { ...s.byConnectionId, [connectionId]: next },
            };
            if (s.activeConnectionId === connectionId) {
                out.recentTables = recentTables;
            }
            return out;
        });
    };

    const ensureTablesLoaded = async (connectionId: string, schema: string, force = false): Promise<void> => {
        const key = scopedKey(connectionId, schema);
        const state = get();
        const per = state.byConnectionId[connectionId];
        if (!per) return;
        const alreadyLoaded = per.tables.some((t) => t.schema === schema);
        if (!force && alreadyLoaded) return;

        const pending = pendingTableLoads.get(key);
        if (!force && pending) {
            await pending;
            return;
        }

        set((s) => {
            const next = { ...s.byConnectionId[connectionId] };
            next.isLoadingTables = true;
            return {
                byConnectionId: { ...s.byConnectionId, [connectionId]: next },
                ...(s.activeConnectionId === connectionId ? { isLoadingTables: true } : {}),
            };
        });

        const request = dbListTables(connectionId, schema)
            .then((nextTables) => {
                const s = get();
                const per = s.byConnectionId[connectionId];
                if (!per) return;
                const merged = mergeTablesForSchema(per.tables, schema, nextTables);
                set((st) => {
                    const next = { ...st.byConnectionId[connectionId], tables: merged, isLoadingTables: false };
                    const out: Partial<ConnectionState> = {
                        byConnectionId: { ...st.byConnectionId, [connectionId]: next },
                    };
                    if (st.activeConnectionId === connectionId) {
                        out.tables = merged;
                        out.isLoadingTables = pendingTableLoads.size > 0;
                    }
                    return out;
                });
            })
            .catch(() => {})
            .finally(() => {
                pendingTableLoads.delete(key);
                const s = get();
                if (s.activeConnectionId === connectionId) {
                    set({ isLoadingTables: pendingTableLoads.size > 0 });
                }
            });

        pendingTableLoads.set(key, request);
        await request;
    };

    const ensureSchemaFunctionsLoaded = async (connectionId: string, schema: string, force = false): Promise<void> => {
        const key = scopedKey(connectionId, schema);
        const state = get();
        const per = state.byConnectionId[connectionId];
        if (!per || !force && per.schemaFunctionsStatus[schema] === "success") return;

        const pending = pendingFunctionLoads.get(key);
        if (!force && pending) {
            await pending;
            return;
        }

        set((s) => {
            const next = { ...s.byConnectionId[connectionId] };
            next.schemaFunctionsStatus = { ...next.schemaFunctionsStatus, [schema]: "loading" };
            next.schemaFunctionsError = { ...next.schemaFunctionsError, [schema]: null };
            return { byConnectionId: { ...s.byConnectionId, [connectionId]: next } };
        });

        const request = dbListFunctions(connectionId, schema)
            .then((functions) => {
                const s = get();
                const per = s.byConnectionId[connectionId];
                if (!per) return;
                set((st) => {
                    const next = { ...st.byConnectionId[connectionId] };
                    next.schemaFunctions = { ...next.schemaFunctions, [schema]: functions };
                    next.schemaFunctionsStatus = { ...next.schemaFunctionsStatus, [schema]: "success" };
                    next.schemaFunctionsError = { ...next.schemaFunctionsError, [schema]: null };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [connectionId]: next } };
                    if (st.activeConnectionId === connectionId) {
                        out.schemaFunctions = next.schemaFunctions;
                        out.schemaFunctionsStatus = next.schemaFunctionsStatus;
                        out.schemaFunctionsError = next.schemaFunctionsError;
                    }
                    return out;
                });
            })
            .catch((error) => {
                const s = get();
                if (!s.byConnectionId[connectionId]) return;
                set((st) => {
                    const next = { ...st.byConnectionId[connectionId] };
                    next.schemaFunctionsStatus = { ...next.schemaFunctionsStatus, [schema]: "error" };
                    next.schemaFunctionsError = { ...next.schemaFunctionsError, [schema]: cleanBackendError(error) };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [connectionId]: next } };
                    if (st.activeConnectionId === connectionId) {
                        out.schemaFunctionsStatus = next.schemaFunctionsStatus;
                        out.schemaFunctionsError = next.schemaFunctionsError;
                    }
                    return out;
                });
            })
            .finally(() => {
                pendingFunctionLoads.delete(key);
            });

        pendingFunctionLoads.set(key, request);
        await request;
    };

    const ensureSchemaTypesLoaded = async (connectionId: string, schema: string, force = false): Promise<void> => {
        const key = scopedKey(connectionId, schema);
        const state = get();
        const per = state.byConnectionId[connectionId];
        if (!per || !force && per.schemaTypesStatus[schema] === "success") return;

        const pending = pendingTypeLoads.get(key);
        if (!force && pending) {
            await pending;
            return;
        }

        set((s) => {
            const next = { ...s.byConnectionId[connectionId] };
            next.schemaTypesStatus = { ...next.schemaTypesStatus, [schema]: "loading" };
            next.schemaTypesError = { ...next.schemaTypesError, [schema]: null };
            return { byConnectionId: { ...s.byConnectionId, [connectionId]: next } };
        });

        const request = dbListTypes(connectionId, schema)
            .then((types) => {
                const s = get();
                if (!s.byConnectionId[connectionId]) return;
                set((st) => {
                    const next = { ...st.byConnectionId[connectionId] };
                    next.schemaTypes = { ...next.schemaTypes, [schema]: types };
                    next.schemaTypesStatus = { ...next.schemaTypesStatus, [schema]: "success" };
                    next.schemaTypesError = { ...next.schemaTypesError, [schema]: null };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [connectionId]: next } };
                    if (st.activeConnectionId === connectionId) {
                        out.schemaTypes = next.schemaTypes;
                        out.schemaTypesStatus = next.schemaTypesStatus;
                        out.schemaTypesError = next.schemaTypesError;
                    }
                    return out;
                });
            })
            .catch((error) => {
                const s = get();
                if (!s.byConnectionId[connectionId]) return;
                set((st) => {
                    const next = { ...st.byConnectionId[connectionId] };
                    next.schemaTypesStatus = { ...next.schemaTypesStatus, [schema]: "error" };
                    next.schemaTypesError = { ...next.schemaTypesError, [schema]: cleanBackendError(error) };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [connectionId]: next } };
                    if (st.activeConnectionId === connectionId) {
                        out.schemaTypesStatus = next.schemaTypesStatus;
                        out.schemaTypesError = next.schemaTypesError;
                    }
                    return out;
                });
            })
            .finally(() => {
                pendingTypeLoads.delete(key);
            });

        pendingTypeLoads.set(key, request);
        await request;
    };

    return {
        connections: [],
        activeConnectionId: null,
        byConnectionId: {},

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
        recentTables: [],
        isLoadingSchemas: false,
        isLoadingTables: false,
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
        refreshTrigger: 0,
        isRefreshingAll: false,

        setConnectionString: (s) => set({ connectionString: s }),
        clearError: () => set({ connectionError: null }),
        markPostConnectRedirectConsumed: () => set({ postConnectRedirectPending: false }),

        setActiveConnection: (connectionId) => {
            set({ activeConnectionId: connectionId });
            syncCurrent();
            if (connectionId) {
                void get().loadRecentTables(connectionId);
            }
        },

        connect: async (connectionString, savedConnectionId, savedLabel, metadata, sshTunnel) => {
            clearAllPendingLoads();
            set({ isConnecting: true, connectionError: null, connectionString });
            try {
                void track("db_connect_attempt", { has_saved_id: !!savedConnectionId });
                const response: ConnectionResponse = await dbConnect(
                    connectionString,
                    savedConnectionId ?? undefined,
                    sshTunnel ?? undefined
                );
                const connId = response.connection_id;
                void track("db_connect_success", { has_saved_id: !!savedConnectionId });
                set({ isLoadingSchemas: true });
                const schemas = await dbListSchemas(connId);
                const publicSchema = schemas.find((s) => s.name === "public");
                const defaultSchema = publicSchema ? "public" : schemas[0]?.name ?? null;
                let tables: TableInfo[] = [];
                const expanded = new Set<string>();
                if (defaultSchema) {
                    tables = await dbListTables(connId, defaultSchema);
                    expanded.add(defaultSchema);
                }

                const label = savedLabel ?? response.database_name ?? "Connection";
                const normalizedMetadata = normalizeConnectionMetadata(metadata);
                const entry: ConnectionEntry = {
                    connectionId: connId,
                    label,
                    databaseName: response.database_name,
                    serverVersion: response.server_version,
                    connectionString,
                    environment: normalizedMetadata.environment,
                    owner: normalizedMetadata.owner,
                    criticality: normalizedMetadata.criticality,
                    savedConnectionId,
                };
                const per = emptyPerConnectionState(connectionString, response.database_name, response.server_version);
                per.schemas = schemas;
                per.selectedSchema = defaultSchema;
                per.tables = tables;
                per.expandedSchemas = expanded;

                set((s) => ({
                    connections: [...s.connections, entry],
                    activeConnectionId: connId,
                    byConnectionId: { ...s.byConnectionId, [connId]: per },
                    isConnected: true,
                    postConnectRedirectPending: true,
                    isConnecting: false,
                    isLoadingSchemas: false,
                    ...syncCurrentFromActive({
                        activeConnectionId: connId,
                        connections: [...s.connections, entry],
                        byConnectionId: { ...s.byConnectionId, [connId]: per },
                    }),
                }));
                void get().loadRecentTables(connId);

                if (savedConnectionId) {
                    updateSavedConnectionDatabaseName(savedConnectionId, response.database_name).catch(() => {});
                }

                dbListDatabases(connId)
                    .then((dbs) => {
                        const s = get();
                        const per = s.byConnectionId[connId];
                        if (!per) return;
                        set((st) => {
                            const next = { ...st.byConnectionId[connId], databases: dbs, isLoadingDatabases: false };
                            const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [connId]: next } };
                            if (st.activeConnectionId === connId) {
                                out.databases = dbs;
                                out.isLoadingDatabases = false;
                            }
                            return out;
                        });
                    })
                    .catch(() => {});
            } catch (error) {
                notifyNoInternetDetected(error);
                set({
                    isConnecting: false,
                    isLoadingSchemas: false,
                    postConnectRedirectPending: false,
                    connectionError: parseConnectionError(String(error)),
                });
                void track("db_connect_error", { has_saved_id: !!savedConnectionId });
            }
        },

        disconnect: async (connectionId) => {
            try {
                await dbDisconnect(connectionId);
            } catch {}
            clearPendingLoadsForConnection(connectionId);
            set((s) => {
                const connections = s.connections.filter((c) => c.connectionId !== connectionId);
                const byConnectionId = { ...s.byConnectionId };
                delete byConnectionId[connectionId];
                let activeConnectionId = s.activeConnectionId;
                if (activeConnectionId === connectionId) {
                    activeConnectionId = connections[0]?.connectionId ?? null;
                }
                const next = {
                    connections,
                    activeConnectionId,
                    byConnectionId,
                    isConnected: connections.length > 0,
                    postConnectRedirectPending: false,
                    connectionError: null as string | null,
                    ...syncCurrentFromActive({ activeConnectionId, connections, byConnectionId }),
                };
                return next;
            });
        },

        loadEventTriggers: async (connectionIdArg?, force = false) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            const per = get().byConnectionId[cid];
            if (!per || (!force && per.eventTriggersStatus === "success")) return;

            const pending = pendingEventTriggerLoads.get(cid);
            if (!force && pending) {
                await pending;
                return;
            }

            set((s) => {
                const next = { ...s.byConnectionId[cid], eventTriggersStatus: "loading" as LoadStatus, eventTriggersError: null };
                return { byConnectionId: { ...s.byConnectionId, [cid]: next }, ...(s.activeConnectionId === cid ? { eventTriggersStatus: "loading" as LoadStatus, eventTriggersError: null } : {}) };
            });

            const request = dbListEventTriggers(cid)
                .then((list) => {
                    const s = get();
                    if (!s.byConnectionId[cid]) return;
                    set((st) => {
                        const next = { ...st.byConnectionId[cid], eventTriggers: list, eventTriggersStatus: "success" as LoadStatus, eventTriggersError: null };
                        const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [cid]: next } };
                        if (st.activeConnectionId === cid) {
                            out.eventTriggers = list;
                            out.eventTriggersStatus = "success";
                            out.eventTriggersError = null;
                        }
                        return out;
                    });
                })
                .catch((error) => {
                    const s = get();
                    if (!s.byConnectionId[cid]) return;
                    set((st) => {
                        const next = { ...st.byConnectionId[cid], eventTriggersStatus: "error" as LoadStatus, eventTriggersError: cleanBackendError(error) };
                        const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [cid]: next } };
                        if (st.activeConnectionId === cid) {
                            out.eventTriggersStatus = "error";
                            out.eventTriggersError = next.eventTriggersError;
                        }
                        return out;
                    });
                })
                .finally(() => {
                    pendingEventTriggerLoads.delete(cid);
                });
            pendingEventTriggerLoads.set(cid, request);
            await request;
        },

        loadSchemaFunctions: async (schema, connectionIdArg?, force = false) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (cid) await ensureSchemaFunctionsLoaded(cid, schema, force);
        },

        loadSchemaTypes: async (schema, connectionIdArg?, force = false) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (cid) await ensureSchemaTypesLoaded(cid, schema, force);
        },

        loadSchemaObjects: async (schema, connectionIdArg?, force = false) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (cid) await Promise.all([ensureSchemaFunctionsLoaded(cid, schema, force), ensureSchemaTypesLoaded(cid, schema, force)]);
        },

        loadRecentTables: async (connectionIdArg?, limit = 8) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            try {
                const recent = await dbListRecentTables(cid, limit);
                setRecentTablesForConnection(cid, recent);
            } catch {
                // ignore transient Rust/backend errors for this non-critical UI list
            }
        },

        switchDatabase: async (connId, targetDatabase) => {
            const state = get();
            const entry = state.connections.find((c) => c.connectionId === connId);
            const per = state.byConnectionId[connId];
            if (!entry || !per || per.databaseName === targetDatabase) return;

            clearPendingLoadsForConnection(connId);
            set((s) => {
                const next = { ...s.byConnectionId[connId], isSwitchingDatabase: true };
                return { byConnectionId: { ...s.byConnectionId, [connId]: next }, ...(s.activeConnectionId === connId ? { isSwitchingDatabase: true } : {}) };
            });

            try {
                await dbDisconnect(connId).catch(() => {});
                const newConnString = replaceDatabase(per.connectionString, targetDatabase);
                const response: ConnectionResponse = await dbConnect(newConnString);
                const newId = response.connection_id;

                const schemas = await dbListSchemas(newId);
                const publicSchema = schemas.find((s) => s.name === "public");
                const defaultSchema = publicSchema ? "public" : schemas[0]?.name ?? null;
                let tables: TableInfo[] = [];
                const expanded = new Set<string>();
                if (defaultSchema) {
                    tables = await dbListTables(newId, defaultSchema);
                    expanded.add(defaultSchema);
                }

                const newEntry: ConnectionEntry = {
                    ...entry,
                    connectionId: newId,
                    databaseName: response.database_name,
                    serverVersion: response.server_version,
                    connectionString: newConnString,
                };
                const newPer = emptyPerConnectionState(newConnString, response.database_name, response.server_version);
                newPer.schemas = schemas;
                newPer.selectedSchema = defaultSchema;
                newPer.tables = tables;
                newPer.expandedSchemas = expanded;
                newPer.databases = per.databases;

                set((s) => {
                    const connections = s.connections.map((c) => (c.connectionId === connId ? newEntry : c));
                    const byConnectionId = { ...s.byConnectionId };
                    delete byConnectionId[connId];
                    byConnectionId[newId] = newPer;
                    const activeConnectionId = s.activeConnectionId === connId ? newId : s.activeConnectionId;
                    return {
                        connections,
                        activeConnectionId,
                        byConnectionId,
                        isSwitchingDatabase: false,
                        isLoadingSchemas: false,
                        ...syncCurrentFromActive({ activeConnectionId, connections, byConnectionId }),
                    };
                });
                void get().loadRecentTables(newId);
            } catch (error) {
                set((s) => {
                    const next = { ...s.byConnectionId[connId], isSwitchingDatabase: false, isLoadingSchemas: false };
                    return { byConnectionId: { ...s.byConnectionId, [connId]: next }, isSwitchingDatabase: false, isLoadingSchemas: false, connectionError: parseConnectionError(String(error)) };
                });
            }
        },

        refreshDatabases: async (connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            set((s) => {
                const next = { ...s.byConnectionId[cid], isLoadingDatabases: true };
                return { byConnectionId: { ...s.byConnectionId, [cid]: next }, ...(s.activeConnectionId === cid ? { isLoadingDatabases: true } : {}) };
            });
            try {
                const dbs = await dbListDatabases(cid);
                const s = get();
                if (!s.byConnectionId[cid]) return;
                set((st) => {
                    const next = { ...st.byConnectionId[cid], databases: dbs, isLoadingDatabases: false };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [cid]: next } };
                    if (st.activeConnectionId === cid) {
                        out.databases = dbs;
                        out.isLoadingDatabases = false;
                    }
                    return out;
                });
            } catch {
                set((s) => {
                    const next = { ...s.byConnectionId[cid], isLoadingDatabases: false };
                    return { byConnectionId: { ...s.byConnectionId, [cid]: next }, ...(s.activeConnectionId === cid ? { isLoadingDatabases: false } : {}) };
                });
            }
        },

        createDatabase: async (name, connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) throw new Error("Not connected");
            await dbCreateDatabase(cid, name);
            const dbs = await dbListDatabases(cid);
            const s = get();
            if (!s.byConnectionId[cid]) return;
            set((st) => {
                const next = { ...st.byConnectionId[cid], databases: dbs };
                return { byConnectionId: { ...st.byConnectionId, [cid]: next }, ...(st.activeConnectionId === cid ? { databases: dbs } : {}) };
            });
        },

        dropDatabase: async (name, connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) throw new Error("Not connected");
            await dbDropDatabase(cid, name);
            const dbs = await dbListDatabases(cid);
            const s = get();
            if (!s.byConnectionId[cid]) return;
            set((st) => {
                const next = { ...st.byConnectionId[cid], databases: dbs };
                return { byConnectionId: { ...st.byConnectionId, [cid]: next }, ...(st.activeConnectionId === cid ? { databases: dbs } : {}) };
            });
        },

        selectSchema: async (schema, connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            set((s) => {
                const per = s.byConnectionId[cid];
                if (!per) return s;
                const expanded = new Set(per.expandedSchemas);
                expanded.add(schema);
                const next = { ...per, selectedSchema: schema, selectedTable: null, expandedSchemas: expanded };
                const out: Partial<ConnectionState> = { byConnectionId: { ...s.byConnectionId, [cid]: next } };
                if (s.activeConnectionId === cid) {
                    out.selectedSchema = schema;
                    out.selectedTable = null;
                    out.expandedSchemas = expanded;
                }
                return out;
            });
            await ensureTablesLoaded(cid, schema);
        },

        selectTable: (schema, table, connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            const per = get().byConnectionId[cid];
            if (!per) return;
            const isView = per.tables.find((t) => t.schema === schema && t.name === table)?.table_type === "VIEW";
            const tableType: "BASE TABLE" | "VIEW" = isView ? "VIEW" : "BASE TABLE";
            const selection: PreviewSelection = { kind: isView ? "view" : "table", schema, name: table };
            set((s) => {
                const expanded = new Set(s.byConnectionId[cid].expandedSchemas);
                expanded.add(schema);
                const next = {
                    ...s.byConnectionId[cid],
                    selectedSchema: schema,
                    selectedTable: table,
                    previewSelection: selection,
                    expandedSchemas: expanded,
                };
                const out: Partial<ConnectionState> = { byConnectionId: { ...s.byConnectionId, [cid]: next }, activeConnectionId: cid };
                if (s.activeConnectionId === cid) {
                    out.selectedSchema = schema;
                    out.selectedTable = table;
                    out.previewSelection = selection;
                    out.expandedSchemas = expanded;
                }
                return out;
            });
            syncCurrent();
            void ensureTablesLoaded(cid, schema).catch(() => {});
            void dbTrackRecentTableOpen(cid, schema, table, tableType)
                .then((recent) => setRecentTablesForConnection(cid, recent))
                .catch(() => {});
        },

        selectPreview: (selection, connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!selection) {
                set((s) => {
                    const out: Partial<ConnectionState> = {};
                    if (cid && s.byConnectionId[cid]) {
                        const next = { ...s.byConnectionId[cid], previewSelection: null, selectedTable: null };
                        out.byConnectionId = { ...s.byConnectionId, [cid]: next };
                        if (s.activeConnectionId === cid) out.previewSelection = null, out.selectedTable = null;
                    }
                    return out;
                });
                return;
            }
            const targetCid = cid ?? (get().connections[0]?.connectionId ?? null);
            if (!targetCid) return;
            set((s) => {
                const per = s.byConnectionId[targetCid];
                if (!per) return s;
                let next = { ...per, previewSelection: selection };
                if (selection.kind === "table" || selection.kind === "view") {
                    next = { ...next, selectedSchema: selection.schema, selectedTable: selection.name };
                } else {
                    next = { ...next, selectedTable: null };
                    if (selection.kind === "function" || selection.kind === "type") next = { ...next, selectedSchema: selection.schema };
                }
                const out: Partial<ConnectionState> = { byConnectionId: { ...s.byConnectionId, [targetCid]: next }, activeConnectionId: targetCid };
                if (s.activeConnectionId === targetCid) {
                    out.previewSelection = selection;
                    out.selectedSchema = next.selectedSchema;
                    out.selectedTable = next.selectedTable;
                }
                return out;
            });
            syncCurrent();
        },

        toggleSchema: (schema, connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            const per = get().byConnectionId[cid];
            if (!per) return;
            const nextExpanded = new Set(per.expandedSchemas);
            if (nextExpanded.has(schema)) {
                nextExpanded.delete(schema);
                set((s) => {
                    const next = { ...s.byConnectionId[cid], expandedSchemas: nextExpanded };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...s.byConnectionId, [cid]: next } };
                    if (s.activeConnectionId === cid) out.expandedSchemas = nextExpanded;
                    return out;
                });
                return;
            }
            nextExpanded.add(schema);
            set((s) => {
                const next = { ...s.byConnectionId[cid], expandedSchemas: nextExpanded };
                const out: Partial<ConnectionState> = { byConnectionId: { ...s.byConnectionId, [cid]: next } };
                if (s.activeConnectionId === cid) out.expandedSchemas = nextExpanded;
                return out;
            });
            ensureTablesLoaded(cid, schema).then(() => {
                const s = get();
                const p = s.byConnectionId[cid];
                if (p && p.selectedSchema == null) {
                    set((st) => {
                        const n = { ...st.byConnectionId[cid], selectedSchema: schema };
                        const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [cid]: n } };
                        if (st.activeConnectionId === cid) out.selectedSchema = schema;
                        return out;
                    });
                }
            }).catch(() => {});
        },

        refreshSchemas: async (connectionIdArg?) => {
            const cid = connectionIdArg ?? get().activeConnectionId;
            if (!cid) return;
            clearPendingLoadsForConnection(cid);
            set((s) => {
                const prev = s.byConnectionId[cid];
                if (!prev) return s;
                const next = {
                    ...prev,
                    isLoadingSchemas: true,
                    tables: [],
                    expandedSchemas: new Set<string>(),
                    eventTriggers: [],
                    eventTriggersStatus: "idle" as LoadStatus,
                    eventTriggersError: null,
                    schemaFunctions: {},
                    schemaFunctionsStatus: {},
                    schemaFunctionsError: {},
                    schemaTypes: {},
                    schemaTypesStatus: {},
                    schemaTypesError: {},
                    isLoadingSchemaObjects: false,
                };
                const out: Partial<ConnectionState> = { byConnectionId: { ...s.byConnectionId, [cid]: next } };
                if (s.activeConnectionId === cid) {
                    out.isLoadingSchemas = true;
                    out.tables = [];
                    out.expandedSchemas = new Set<string>();
                    out.eventTriggers = [];
                    out.eventTriggersStatus = "idle";
                    out.eventTriggersError = null;
                    out.schemaFunctions = {};
                    out.schemaFunctionsStatus = {};
                    out.schemaFunctionsError = {};
                    out.schemaTypes = {};
                    out.schemaTypesStatus = {};
                    out.schemaTypesError = {};
                    out.isLoadingSchemaObjects = false;
                }
                return out;
            });
            try {
                const schemas = await dbRefreshCache(cid);
                const s = get();
                const per = s.byConnectionId[cid];
                if (!per) return;
                const selectedSchema = per.selectedSchema;
                set((st) => {
                    const next = { ...st.byConnectionId[cid], schemas, isLoadingSchemas: false };
                    const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [cid]: next } };
                    if (st.activeConnectionId === cid) out.schemas = schemas, out.isLoadingSchemas = false;
                    return out;
                });
                if (selectedSchema) {
                    await ensureTablesLoaded(cid, selectedSchema, true);
                    const s2 = get();
                    if (s2.byConnectionId[cid]) {
                        set((st) => {
                            const next = { ...st.byConnectionId[cid], expandedSchemas: new Set([selectedSchema]) };
                            const out: Partial<ConnectionState> = { byConnectionId: { ...st.byConnectionId, [cid]: next } };
                            if (st.activeConnectionId === cid) out.expandedSchemas = new Set([selectedSchema]);
                            return out;
                        });
                    }
                }
            } catch {
                set((s) => {
                    const next = { ...s.byConnectionId[cid], isLoadingSchemas: false };
                    return { byConnectionId: { ...s.byConnectionId, [cid]: next }, ...(s.activeConnectionId === cid ? { isLoadingSchemas: false } : {}) };
                });
            }
        },

        refreshAll: async () => {
            const cid = get().activeConnectionId;
            if (!cid) return;
            set({ isRefreshingAll: true, refreshTrigger: get().refreshTrigger + 1 });
            try {
                await Promise.all([get().refreshSchemas(cid), get().refreshDatabases(cid)]);
            } finally {
                set({ isRefreshingAll: false });
            }
        },
    };
});
