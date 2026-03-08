export interface GitProjectIdentity {
    projectKey: string;
    host: string;
    workspaceName: string;
}

function normalizeKeySegment(value: string, fallback: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return normalized || fallback;
}

function parseHostAndPort(connectionString?: string | null): { host: string; port: string } {
    if (!connectionString) return { host: "connection", port: "" };
    try {
        const url = new URL(connectionString);
        return {
            host: url.hostname || "connection",
            port: url.port || "",
        };
    } catch {
        return { host: "connection", port: "" };
    }
}

function parseDatabaseName(connectionString?: string | null): string | null {
    if (!connectionString) return null;
    try {
        const url = new URL(connectionString);
        const name = decodeURIComponent(url.pathname.replace(/^\/+/, "")).trim();
        return name || null;
    } catch {
        return null;
    }
}

export function deriveGitProjectIdentity(
    connectionId: string,
    connectionString?: string | null,
    databaseName?: string | null
): GitProjectIdentity {
    const { host, port } = parseHostAndPort(connectionString);
    const hostLabel = port ? `${host}:${port}` : host;
    const workspaceLabel =
        databaseName?.trim() ||
        parseDatabaseName(connectionString) ||
        connectionId ||
        "workspace";

    const projectKey = `pg://${normalizeKeySegment(hostLabel, "connection")}/${normalizeKeySegment(
        workspaceLabel,
        "workspace"
    )}`;

    return {
        projectKey,
        host: hostLabel,
        workspaceName: workspaceLabel,
    };
}
