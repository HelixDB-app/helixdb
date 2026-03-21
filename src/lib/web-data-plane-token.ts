/**
 * Short-lived bearer for `helix-data-plane` when the control plane returns
 * `dataPlaneAccessToken` from `/api/user/me` (optional contract).
 * Stored in sessionStorage — cleared on logout.
 */
const SESSION_KEY = "helix_data_plane_jwt";

export function getWebDataPlaneBearerToken(): string | null {
    if (typeof sessionStorage === "undefined") return null;
    try {
        const v = sessionStorage.getItem(SESSION_KEY)?.trim();
        return v || null;
    } catch {
        return null;
    }
}

export function setWebDataPlaneBearerToken(token: string | null): void {
    if (typeof sessionStorage === "undefined") return;
    try {
        if (token?.trim()) {
            sessionStorage.setItem(SESSION_KEY, token.trim());
        } else {
            sessionStorage.removeItem(SESSION_KEY);
        }
    } catch {
        /* private mode / quota */
    }
}
