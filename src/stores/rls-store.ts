import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Best-effort message from Tauri / Postgres (avoids bare "db error"). */
export function formatInvokeError(err: unknown): string {
    if (typeof err === "string") return err;
    if (err instanceof Error) {
        const m = err.message?.trim() || "";
        const c = (err as Error & { cause?: unknown }).cause;
        if ((m === "db error" || m === "") && c !== undefined && c !== null) {
            if (c instanceof Error && c.message) return `${m ? `${m}\n\n` : ""}${c.message}`;
            return `${m ? `${m}\n\n` : ""}${String(c)}`;
        }
        return m || String(err);
    }
    if (err && typeof err === "object") {
        const o = err as Record<string, unknown>;
        if (typeof o.message === "string" && o.message.trim()) return o.message;
        if (typeof o.payload === "string" && o.payload.trim()) return o.payload;
    }
    return String(err);
}

/** Matches PostgreSQL policy command; mirrors Rust `PolicyRow.cmd`. */
export type PolicyCmd = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";

/** Mirrors `rls::PolicyRow` (serde snake_case). */
export interface PolicyRow {
    schemaname: string;
    tablename: string;
    policyname: string;
    roles: string[];
    cmd: string;
    permissive: string;
    qual: string | null;
    with_check: string | null;
}

/** Mirrors `rls::RoleRow`. */
export interface RoleRow {
    rolname: string;
    rolsuper: boolean;
    rolinherit: boolean;
    rolcanlogin: boolean;
}

/** Mirrors `rls::RlsMatrixData`. */
export interface RlsMatrixData {
    policies: PolicyRow[];
    roles: RoleRow[];
    rls_enabled_tables: string[];
}

/** Mirrors `rls::ImpersonationResult`. */
export interface ImpersonationResult {
    success: boolean;
    row_count: number;
    rows: Record<string, unknown>[];
    error: string | null;
    role_used: string;
    sql_executed: string;
}

function uniqueSorted(names: string[]): string[] {
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** Policies that apply to this role × table × operation (ALL matches any op; empty/public roles match everyone). */
export function getPoliciesForCell(
    policies: PolicyRow[],
    role: string,
    table: string,
    op: PolicyCmd,
): PolicyRow[] {
    return policies.filter((p) => {
        if (p.tablename !== table) return false;
        const cmd = p.cmd.toUpperCase();
        const cmdMatch = cmd === op || cmd === "ALL";
        if (!cmdMatch) return false;
        const r = p.roles;
        if (r.length === 0) return true;
        if (r.includes(role)) return true;
        if (r.some((x) => x.toLowerCase() === "public")) return true;
        return false;
    });
}

interface RlsState {
    policies: PolicyRow[];
    roles: RoleRow[];
    rlsEnabledTables: string[];
    tables: string[];
    selectedSchema: string;
    isLoading: boolean;
    loadError: string | null;
    impersonation: {
        activeRole: string | null;
        activeTable: string | null;
        activeOp: PolicyCmd | null;
        result: ImpersonationResult | null;
        customSql: string;
        isProbing: boolean;
    };

    loadMatrix: (connectionId: string, schema: string) => Promise<void>;
    runProbe: (connectionId: string, role: string, table: string) => Promise<void>;
    setActiveCell: (
        role: string | null,
        table: string | null,
        op?: PolicyCmd | null,
    ) => void;
    setCustomSql: (sql: string) => void;
    setSchema: (schema: string) => void;
    resetImpersonation: () => void;
}

export const useRlsStore = create<RlsState>((set, get) => ({
    policies: [],
    roles: [],
    rlsEnabledTables: [],
    tables: [],
    selectedSchema: "public",
    isLoading: false,
    loadError: null,
    impersonation: {
        activeRole: null,
        activeTable: null,
        activeOp: null,
        result: null,
        customSql: "",
        isProbing: false,
    },

    loadMatrix: async (connectionId: string, schema: string) => {
        set({ isLoading: true, loadError: null, selectedSchema: schema });
        try {
            const data = await invoke<RlsMatrixData>("rls_matrix_data", {
                connectionId,
                schema,
            });
            const fromPolicies = data.policies.map((p) => p.tablename);
            const tables = uniqueSorted([
                ...fromPolicies,
                ...data.rls_enabled_tables,
            ]);
            set({
                policies: data.policies,
                roles: data.roles,
                rlsEnabledTables: data.rls_enabled_tables,
                tables,
                isLoading: false,
            });
        } catch (e) {
            set({
                isLoading: false,
                loadError: formatInvokeError(e),
                policies: [],
                roles: [],
                rlsEnabledTables: [],
                tables: [],
            });
        }
    },

    runProbe: async (connectionId: string, role: string, table: string) => {
        const { selectedSchema, impersonation } = get();
        const custom = impersonation.customSql.trim();
        set((s) => ({
            impersonation: { ...s.impersonation, isProbing: true, result: null },
        }));
        try {
            const result = await invoke<ImpersonationResult>("rls_impersonate_query", {
                connectionId,
                role,
                schema: selectedSchema,
                table,
                customSql: custom.length > 0 ? custom : null,
            });
            const normalized: ImpersonationResult = {
                ...result,
                rows: (result.rows ?? []) as Record<string, unknown>[],
            };
            set((s) => ({
                impersonation: {
                    ...s.impersonation,
                    isProbing: false,
                    result: normalized,
                },
            }));
        } catch (e) {
            const msg = formatInvokeError(e);
            set((s) => ({
                impersonation: {
                    ...s.impersonation,
                    isProbing: false,
                    result: {
                        success: false,
                        row_count: 0,
                        rows: [],
                        error: msg,
                        role_used: role,
                        sql_executed: "",
                    },
                },
            }));
        }
    },

    setActiveCell: (role, table, op = null) => {
        const schema = get().selectedSchema;
        const defaultSql =
            role && table
                ? `SELECT * FROM "${schema}"."${table}" LIMIT 20`
                : "";
        set((s) => ({
            impersonation: {
                ...s.impersonation,
                activeRole: role,
                activeTable: table,
                activeOp: op,
                result: null,
                customSql: role && table ? defaultSql : "",
            },
        }));
    },

    setCustomSql: (sql: string) => {
        set((s) => ({
            impersonation: { ...s.impersonation, customSql: sql },
        }));
    },

    setSchema: (schema: string) => {
        set({ selectedSchema: schema });
    },

    resetImpersonation: () => {
        set({
            impersonation: {
                activeRole: null,
                activeTable: null,
                activeOp: null,
                result: null,
                customSql: "",
                isProbing: false,
            },
        });
    },
}));
