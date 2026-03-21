/**
 * Single data-plane abstraction: Tauri invoke on desktop, HTTP API in the browser.
 * Phase 1: connect, disconnect, refresh metadata, list schemas/tables, table rows, execute query.
 */
import { isTauri } from "@/lib/tauri-runtime";
import { getWebDataPlaneBearerToken } from "@/lib/web-data-plane-token";

let didWarnPublicDataPlaneKey = false;
import type {
    ColumnInfo,
    ConnectionResponse,
    ConnectionEnvironment,
    PgSession,
    QueryResult,
    SchemaInfo,
    SshTunnelConfig,
    TableDetails,
    TableInfo,
    TopologyData,
} from "@/lib/types";
import * as tauri from "@/lib/tauri";

export interface DbExecuteQueryOptions {
    environment?: ConnectionEnvironment | null;
    guardReason?: string | null;
}

export interface DbPlatform {
    dbConnect(
        connectionString: string,
        connectionId?: string | null,
        sshTunnel?: SshTunnelConfig | null
    ): Promise<ConnectionResponse>;
    dbDisconnect(connectionId: string): Promise<boolean>;
    dbRefreshCache(connectionId: string): Promise<SchemaInfo[]>;
    dbListSchemas(connectionId: string): Promise<SchemaInfo[]>;
    dbListTables(connectionId: string, schema: string): Promise<TableInfo[]>;
    dbGetTableData(
        connectionId: string,
        schema: string,
        table: string,
        page: number,
        pageSize: number,
        sortColumn?: string,
        sortDirection?: string
    ): Promise<QueryResult>;
    dbExecuteQuery(
        connectionId: string,
        sql: string,
        options?: DbExecuteQueryOptions
    ): Promise<QueryResult>;
    dbGetSessions(connectionId: string): Promise<PgSession[]>;
    dbTerminateBackend(connectionId: string, pid: number): Promise<boolean>;
    dbCancelBackend(connectionId: string, pid: number): Promise<boolean>;
    dbGetSchemaTopology(connectionId: string, schema: string): Promise<TopologyData>;
    dbGetColumns(
        connectionId: string,
        schema: string,
        table: string
    ): Promise<ColumnInfo[]>;
    dbGetTableDetails(
        connectionId: string,
        schema: string,
        table: string
    ): Promise<TableDetails>;
}

class TauriDbPlatform implements DbPlatform {
    dbConnect(
        connectionString: string,
        connectionId?: string | null,
        sshTunnel?: SshTunnelConfig | null
    ) {
        return tauri.dbConnect(connectionString, connectionId, sshTunnel);
    }
    dbDisconnect(connectionId: string) {
        return tauri.dbDisconnect(connectionId);
    }
    dbRefreshCache(connectionId: string) {
        return tauri.dbRefreshCache(connectionId);
    }
    dbListSchemas(connectionId: string) {
        return tauri.dbListSchemas(connectionId);
    }
    dbListTables(connectionId: string, schema: string) {
        return tauri.dbListTables(connectionId, schema);
    }
    dbGetTableData(
        connectionId: string,
        schema: string,
        table: string,
        page: number,
        pageSize: number,
        sortColumn?: string,
        sortDirection?: string
    ) {
        return tauri.dbGetTableData(
            connectionId,
            schema,
            table,
            page,
            pageSize,
            sortColumn,
            sortDirection
        );
    }
    dbExecuteQuery(connectionId: string, sql: string, options?: DbExecuteQueryOptions) {
        return tauri.dbExecuteQuery(connectionId, sql, {
            environment: options?.environment ?? null,
            guardReason: options?.guardReason ?? null,
        });
    }
    dbGetSessions(connectionId: string) {
        return tauri.dbGetSessions(connectionId);
    }
    dbTerminateBackend(connectionId: string, pid: number) {
        return tauri.dbTerminateBackend(connectionId, pid);
    }
    dbCancelBackend(connectionId: string, pid: number) {
        return tauri.dbCancelBackend(connectionId, pid);
    }
    dbGetSchemaTopology(connectionId: string, schema: string) {
        return tauri.dbGetSchemaTopology(connectionId, schema);
    }
    dbGetColumns(connectionId: string, schema: string, table: string) {
        return tauri.dbGetColumns(connectionId, schema, table);
    }
    dbGetTableDetails(connectionId: string, schema: string, table: string) {
        return tauri.dbGetTableDetails(connectionId, schema, table);
    }
}

function httpBaseUrl(): string | null {
    const u = process.env.NEXT_PUBLIC_DATA_PLANE_URL?.trim();
    if (!u) return null;
    return u.replace(/\/+$/, "");
}

/**
 * Public API key in the browser bundle is only for local/dev. Production builds ignore it unless
 * `NEXT_PUBLIC_DATA_PLANE_ALLOW_PUBLIC_API_KEY=true` is set (internal demos only).
 */
function httpApiKey(): string | null {
    const isProd = process.env.NODE_ENV === "production";
    const allowPublic =
        process.env.NEXT_PUBLIC_DATA_PLANE_ALLOW_PUBLIC_API_KEY === "true";
    const k = process.env.NEXT_PUBLIC_DATA_PLANE_API_KEY?.trim();
    if (isProd && k && !allowPublic && typeof window !== "undefined" && !didWarnPublicDataPlaneKey) {
        didWarnPublicDataPlaneKey = true;
        console.warn(
            "[Helix] NEXT_PUBLIC_DATA_PLANE_API_KEY is ignored in production. Use data-plane JWT (from /api/user/me) or a same-origin BFF."
        );
    }
    if (isProd && !allowPublic) {
        return null;
    }
    return k || null;
}

class HttpDbPlatform implements DbPlatform {
    private base: string;

    constructor(base: string) {
        this.base = base.replace(/\/+$/, "");
    }

    private headers(jsonBody?: boolean): HeadersInit {
        const h: Record<string, string> = {};
        if (jsonBody) {
            h["Content-Type"] = "application/json";
        }
        const userJwt = getWebDataPlaneBearerToken();
        if (userJwt) {
            h.Authorization = `Bearer ${userJwt}`;
            return h;
        }
        const key = httpApiKey();
        if (key) {
            h.Authorization = `Bearer ${key}`;
        }
        return h;
    }

    private async json<T>(res: Response): Promise<T> {
        const text = await res.text();
        if (!res.ok) {
            throw new Error(text || res.statusText || `HTTP ${res.status}`);
        }
        if (!text) {
            return undefined as T;
        }
        return JSON.parse(text) as T;
    }

    async dbConnect(
        connectionString: string,
        connectionId?: string | null,
        sshTunnel?: SshTunnelConfig | null
    ): Promise<ConnectionResponse> {
        if (sshTunnel?.use_ssh_tunneling) {
            throw new Error(
                "SSH tunneling is not supported for the web data plane. Use desktop or a VPN."
            );
        }
        const res = await fetch(`${this.base}/v1/connections`, {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                connection_string: connectionString,
                connection_id: connectionId ?? undefined,
            }),
        });
        return this.json<ConnectionResponse>(res);
    }

    async dbDisconnect(connectionId: string): Promise<boolean> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}`,
            { method: "DELETE", headers: this.headers() }
        );
        if (res.status === 404) return false;
        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || res.statusText);
        }
        return true;
    }

    async dbRefreshCache(connectionId: string): Promise<SchemaInfo[]> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/metadata/refresh`,
            { method: "POST", headers: this.headers(true) }
        );
        return this.json<SchemaInfo[]>(res);
    }

    async dbListSchemas(connectionId: string): Promise<SchemaInfo[]> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/schemas`,
            { headers: this.headers() }
        );
        return this.json<SchemaInfo[]>(res);
    }

    async dbListTables(connectionId: string, schema: string): Promise<TableInfo[]> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables`,
            { headers: this.headers() }
        );
        return this.json<TableInfo[]>(res);
    }

    async dbGetTableData(
        connectionId: string,
        schema: string,
        table: string,
        page: number,
        pageSize: number,
        sortColumn?: string,
        sortDirection?: string
    ): Promise<QueryResult> {
        const q = new URLSearchParams({
            page: String(page),
            page_size: String(pageSize),
        });
        if (sortColumn) q.set("sort_column", sortColumn);
        if (sortDirection) q.set("sort_direction", sortDirection);
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/rows?${q}`,
            { headers: this.headers() }
        );
        return this.json<QueryResult>(res);
    }

    async dbExecuteQuery(
        connectionId: string,
        sql: string,
        options?: DbExecuteQueryOptions
    ): Promise<QueryResult> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/query`,
            {
                method: "POST",
                headers: this.headers(true),
                body: JSON.stringify({
                    sql,
                    environment: options?.environment ?? null,
                    guard_reason: options?.guardReason ?? null,
                }),
            }
        );
        return this.json<QueryResult>(res);
    }

    async dbGetSessions(connectionId: string): Promise<PgSession[]> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/sessions`,
            { headers: this.headers() }
        );
        return this.json<PgSession[]>(res);
    }

    async dbTerminateBackend(connectionId: string, pid: number): Promise<boolean> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/sessions/${encodeURIComponent(String(pid))}/terminate`,
            { method: "POST", headers: this.headers() }
        );
        return this.json<boolean>(res);
    }

    async dbCancelBackend(connectionId: string, pid: number): Promise<boolean> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/sessions/${encodeURIComponent(String(pid))}/cancel`,
            { method: "POST", headers: this.headers() }
        );
        return this.json<boolean>(res);
    }

    async dbGetSchemaTopology(
        connectionId: string,
        schema: string
    ): Promise<TopologyData> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/topology`,
            { headers: this.headers() }
        );
        return this.json<TopologyData>(res);
    }

    async dbGetColumns(
        connectionId: string,
        schema: string,
        table: string
    ): Promise<ColumnInfo[]> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/columns`,
            { headers: this.headers() }
        );
        return this.json<ColumnInfo[]>(res);
    }

    async dbGetTableDetails(
        connectionId: string,
        schema: string,
        table: string
    ): Promise<TableDetails> {
        const res = await fetch(
            `${this.base}/v1/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/details`,
            { headers: this.headers() }
        );
        return this.json<TableDetails>(res);
    }
}

let cached: DbPlatform | null = null;
let didLogDataPlaneDefault = false;

/** Used when `NEXT_PUBLIC_DATA_PLANE_URL` is unset in the browser (matches `make data-plane` default). */
const DEFAULT_BROWSER_DATA_PLANE_URL = "http://127.0.0.1:9847";

function resolveHttpBaseUrl(): string {
    const explicit = httpBaseUrl();
    if (explicit) return explicit;
    if (typeof window !== "undefined") {
        if (process.env.NODE_ENV === "development" && !didLogDataPlaneDefault) {
            didLogDataPlaneDefault = true;
            console.info(
                `[Helix] NEXT_PUBLIC_DATA_PLANE_URL not set; using ${DEFAULT_BROWSER_DATA_PLANE_URL}. ` +
                    "Set NEXT_PUBLIC_DATA_PLANE_URL for production, and run `make data-plane` (or Docker Compose)."
            );
        }
        return DEFAULT_BROWSER_DATA_PLANE_URL;
    }
    return DEFAULT_BROWSER_DATA_PLANE_URL;
}

export function createDbPlatform(): DbPlatform {
    if (cached) return cached;
    if (isTauri()) {
        cached = new TauriDbPlatform();
        return cached;
    }
    cached = new HttpDbPlatform(resolveHttpBaseUrl());
    return cached;
}

/** Testing / hot reload: clear singleton platform. */
export function resetDbPlatformForTests(): void {
    cached = null;
    didLogDataPlaneDefault = false;
}

/** Prefer importing these named functions so call sites stay one-liners during migration. */
const p = () => createDbPlatform();

export function dbConnect(
    connectionString: string,
    connectionId?: string | null,
    sshTunnel?: SshTunnelConfig | null
) {
    return p().dbConnect(connectionString, connectionId, sshTunnel);
}

export function dbDisconnect(connectionId: string) {
    return p().dbDisconnect(connectionId);
}

export function dbRefreshCache(connectionId: string) {
    return p().dbRefreshCache(connectionId);
}

export function dbListSchemas(connectionId: string) {
    return p().dbListSchemas(connectionId);
}

export function dbListTables(connectionId: string, schema: string) {
    return p().dbListTables(connectionId, schema);
}

export function dbGetTableData(
    connectionId: string,
    schema: string,
    table: string,
    page: number,
    pageSize: number,
    sortColumn?: string,
    sortDirection?: string
) {
    return p().dbGetTableData(
        connectionId,
        schema,
        table,
        page,
        pageSize,
        sortColumn,
        sortDirection
    );
}

export function dbExecuteQuery(
    connectionId: string,
    sql: string,
    options?: DbExecuteQueryOptions
) {
    return p().dbExecuteQuery(connectionId, sql, options);
}

export function dbGetSessions(connectionId: string) {
    return p().dbGetSessions(connectionId);
}

export function dbTerminateBackend(connectionId: string, pid: number) {
    return p().dbTerminateBackend(connectionId, pid);
}

export function dbCancelBackend(connectionId: string, pid: number) {
    return p().dbCancelBackend(connectionId, pid);
}

export function dbGetSchemaTopology(connectionId: string, schema: string) {
    return p().dbGetSchemaTopology(connectionId, schema);
}

export function dbGetColumns(connectionId: string, schema: string, table: string) {
    return p().dbGetColumns(connectionId, schema, table);
}

export function dbGetTableDetails(connectionId: string, schema: string, table: string) {
    return p().dbGetTableDetails(connectionId, schema, table);
}
