import type {
    ConnectionCriticality,
    ConnectionEnvironment,
    SavedConnection,
    SshTunnelConfig,
} from "./types";

export interface ConnectionMetadataInput {
    environment?: ConnectionEnvironment | string | null;
    owner?: string | null;
    criticality?: ConnectionCriticality | string | null;
}

export const DEFAULT_CONNECTION_ENVIRONMENT: ConnectionEnvironment = "dev";
export const DEFAULT_CONNECTION_CRITICALITY: ConnectionCriticality = "medium";

export function normalizeConnectionEnvironment(
    value?: ConnectionEnvironment | string | null
): ConnectionEnvironment {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();

    if (normalized === "prod") return "prod";
    if (normalized === "staging") return "staging";
    return "dev";
}

export function normalizeConnectionCriticality(
    value?: ConnectionCriticality | string | null
): ConnectionCriticality {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();

    if (normalized === "low") return "low";
    if (normalized === "high") return "high";
    return "medium";
}

export function normalizeConnectionOwner(value?: string | null): string | null {
    const owner = value?.trim();
    return owner ? owner : null;
}

export function normalizeConnectionMetadata(
    input?: ConnectionMetadataInput | null
): {
    environment: ConnectionEnvironment;
    owner: string | null;
    criticality: ConnectionCriticality;
} {
    return {
        environment: normalizeConnectionEnvironment(input?.environment),
        owner: normalizeConnectionOwner(input?.owner),
        criticality: normalizeConnectionCriticality(input?.criticality),
    };
}

function normalizeSshTunnel(st: SshTunnelConfig | null | undefined): SshTunnelConfig | null | undefined {
    if (!st || !st.use_ssh_tunneling) return st ?? null;
    return {
        ...st,
        tunnel_port: typeof st.tunnel_port === "number" && st.tunnel_port > 0 ? st.tunnel_port : 22,
        keep_alive_seconds: typeof st.keep_alive_seconds === "number" && st.keep_alive_seconds >= 0 ? st.keep_alive_seconds : 0,
    };
}

export function normalizeSavedConnection(connection: SavedConnection): SavedConnection {
    const normalized = normalizeConnectionMetadata(connection);
    const ssh_tunnel =
        connection.ssh_tunnel != null
            ? (normalizeSshTunnel(connection.ssh_tunnel) ?? connection.ssh_tunnel)
            : connection.ssh_tunnel;
    return {
        ...connection,
        environment: normalized.environment,
        owner: normalized.owner,
        criticality: normalized.criticality,
        ...(ssh_tunnel !== undefined ? { ssh_tunnel } : {}),
    };
}

export function formatEnvironmentLabel(environment?: ConnectionEnvironment | string | null): string {
    const env = normalizeConnectionEnvironment(environment);
    if (env === "prod") return "PROD";
    if (env === "staging") return "STAGING";
    return "DEV";
}

export function formatCriticalityLabel(criticality?: ConnectionCriticality | string | null): string {
    const level = normalizeConnectionCriticality(criticality);
    if (level === "high") return "High";
    if (level === "low") return "Low";
    return "Medium";
}

export function isProductionEnvironment(environment?: ConnectionEnvironment | string | null): boolean {
    return normalizeConnectionEnvironment(environment) === "prod";
}

export function environmentBadgeClass(environment?: ConnectionEnvironment | string | null): string {
    const env = normalizeConnectionEnvironment(environment);
    if (env === "prod") {
        return "border-red-500/35 text-red-300 bg-red-500/10";
    }
    if (env === "staging") {
        return "border-amber-500/35 text-amber-300 bg-amber-500/10";
    }
    return "border-emerald-500/35 text-emerald-300 bg-emerald-500/10";
}
