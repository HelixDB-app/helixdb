/**
 * GeminiLogger — Non-blocking, fire-and-forget Gemini API usage logger.
 *
 * Architecture:
 *  - Logs accumulate in an in-memory buffer
 *  - A flush fires automatically when buffer hits BATCH_SIZE or FLUSH_INTERVAL_MS
 *  - All network I/O is non-blocking; the caller never awaits this
 *  - No-ops silently if auth token is not set (unauthenticated users)
 */

export type ApiFeatureType =
    | "chat"
    | "suggestions"
    | "doc-writer"
    | "sql-review"
    | "seed-data"
    | "index-optimization"
    | "query-error"
    | "query-explain"
    | "git"
    | "other";

export interface GeminiLogEntry {
    model: string;
    featureType: ApiFeatureType;
    endpoint: string;
    requestTimestamp: string; // ISO
    responseTime: number;     // ms
    status: "success" | "error" | "aborted";
    tokenUsed?: number;
    promptTokens?: number;
    candidateTokens?: number;
    errorMessage?: string;
    errorCode?: number;
}

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 30_000; // 30 s

const WEB_BASE_URL =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WEB_APP_URL) ??
    `${process.env.NEXT_PUBLIC_WEB_APP_URL ?? "https://pgstudio-web.vercel.app"}`;

class GeminiLoggerSingleton {
    private buffer: GeminiLogEntry[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private authToken: string | null = null;

    /** Call this once after the user logs in (or on app start if already authenticated). */
    setAuthToken(token: string | null): void {
        this.authToken = token;
    }

    /**
     * Record a Gemini API call.
     * Returns immediately — never throws.
     */
    log(entry: GeminiLogEntry): void {
        this.buffer.push(entry);
        this.scheduleFlush();

        if (this.buffer.length >= BATCH_SIZE) {
            this.flush();
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }

    /** Drain the buffer and POST to server. Fire-and-forget. */
    flush(): void {
        if (this.buffer.length === 0) return;
        if (!this.authToken) {
            // Try to read from localStorage (set by the auth flow)
            if (typeof window !== "undefined") {
                this.authToken = localStorage.getItem("pgstudio_jwt");
            }
        }
        if (!this.authToken) return; // Unauthenticated — drop silently

        const batch = this.buffer.splice(0, this.buffer.length);

        // Send each log individually so the server stays simple (one log per request)
        for (const entry of batch) {
            this.sendOne(entry).catch(() => {
                // Re-queue on network failure (best-effort, no retry loop)
            });
        }
    }

    private async sendOne(entry: GeminiLogEntry): Promise<void> {
        const token = this.authToken;
        if (!token) return;

        try {
            await fetch(`${WEB_BASE_URL}/api/gemini-logs`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(entry),
                // Don't block the response path
                keepalive: true,
            });
        } catch {
            // Network error — silently discard to avoid impacting UX
        }
    }

    /** Force-flush remaining logs (e.g. on app exit). */
    async flushAndWait(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const batch = this.buffer.splice(0, this.buffer.length);
        if (batch.length === 0) return;

        const token = this.authToken ?? (typeof window !== "undefined"
            ? localStorage.getItem("pgstudio_jwt")
            : null);

        if (!token) return;

        await Promise.allSettled(
            batch.map((entry) =>
                fetch(`${WEB_BASE_URL}/api/gemini-logs`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(entry),
                    keepalive: true,
                }).catch(() => { })
            )
        );
    }
}

export const geminiLogger = new GeminiLoggerSingleton();

// ── Convenience helpers ───────────────────────────────────────────────────────

/** Wrap a Gemini call with automatic timing + logging. */
export async function withGeminiLogging<T>(
    callFn: () => Promise<T>,
    meta: Pick<GeminiLogEntry, "model" | "featureType" | "endpoint">
): Promise<T> {
    const start = Date.now();
    const requestTimestamp = new Date().toISOString();

    try {
        const result = await callFn();
        geminiLogger.log({
            ...meta,
            requestTimestamp,
            responseTime: Date.now() - start,
            status: "success",
        });
        return result;
    } catch (error: unknown) {
        const isAbort =
            error instanceof DOMException && error.name === "AbortError";

        geminiLogger.log({
            ...meta,
            requestTimestamp,
            responseTime: Date.now() - start,
            status: isAbort ? "aborted" : "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            errorCode:
                (error as { code?: number })?.code ?? undefined,
        });

        throw error;
    }
}
