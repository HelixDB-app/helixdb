/**
 * Bearer JWT for pgstudio-web `/api/user/me` when the UI runs on another origin
 * (e.g. localhost:3000 → auth on :3001 or Vercel). Cross-site cookies are not sent on fetch,
 * so after login we receive a one-time token in the URL hash and persist it here.
 *
 * Stored in localStorage so every tab shares the same session (sessionStorage was tab-only).
 */
const SESSION_KEY = "helix_pgstudio_account_jwt";

export function getWebAccountJwt(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const fromLocal = localStorage.getItem(SESSION_KEY)?.trim();
        if (fromLocal) return fromLocal;
        const legacy = sessionStorage.getItem(SESSION_KEY)?.trim();
        if (legacy) {
            try {
                localStorage.setItem(SESSION_KEY, legacy);
            } catch {
                /* quota / private mode */
            }
            sessionStorage.removeItem(SESSION_KEY);
            return legacy;
        }
        return null;
    } catch {
        return null;
    }
}

export function setWebAccountJwt(token: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (token?.trim()) {
            localStorage.setItem(SESSION_KEY, token.trim());
            sessionStorage.removeItem(SESSION_KEY);
        } else {
            localStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_KEY);
        }
    } catch {
        /* private mode */
    }
}

/** Hash fragment name written by pgstudio-web `/auth/callback` (source=web). */
export const WEB_ACCOUNT_JWT_HASH_PARAM = "helix_account_jwt";
