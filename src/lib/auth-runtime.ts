/**
 * Desktop: Tauri keychain + Rust profile fetch.
 * Web / iPad: cookie session against control plane `/api/user/me` + optional data-plane bearer.
 */
import { isTauri } from "@/lib/tauri-runtime";
import type { UserProfile } from "@/stores/auth-store";
import { getWebAppBaseUrl } from "@/lib/web-app-url";
import { setWebDataPlaneBearerToken } from "@/lib/web-data-plane-token";
import { getWebAccountJwt, setWebAccountJwt } from "@/lib/web-account-jwt";

export async function runtimeAuthGetToken(): Promise<string | null> {
    if (!isTauri()) return null;
    const { authGetToken } = await import("@/lib/tauri");
    return authGetToken();
}

/** Control-plane `/api/user/me` may include this field for browser data-plane access. */
interface UserMePayload extends UserProfile {
    dataPlaneAccessToken?: string;
}

export async function runtimeAuthFetchProfile(): Promise<UserProfile | null> {
    if (isTauri()) {
        const { authFetchProfile } = await import("@/lib/tauri");
        return authFetchProfile();
    }

    const base = getWebAppBaseUrl();
    const accountJwt = getWebAccountJwt();
    const headers: Record<string, string> = {};
    if (accountJwt) {
        headers.Authorization = `Bearer ${accountJwt}`;
    }

    try {
        const res = await fetch(`${base}/api/user/me`, {
            // Cookies are not sent cross-site (e.g. :3000 → pgstudio-web); Bearer is enough.
            credentials: accountJwt ? "omit" : "include",
            mode: "cors",
            headers: Object.keys(headers).length ? headers : undefined,
        });

        if (res.status === 401 || res.status === 403) {
            setWebDataPlaneBearerToken(null);
            setWebAccountJwt(null);
            return null;
        }

        if (res.status === 404 || !res.ok) {
            setWebDataPlaneBearerToken(null);
            return null;
        }

        const raw = (await res.json()) as UserMePayload;
        const { dataPlaneAccessToken, ...profile } = raw;
        if (typeof dataPlaneAccessToken === "string" && dataPlaneAccessToken.trim()) {
            setWebDataPlaneBearerToken(dataPlaneAccessToken.trim());
        } else {
            setWebDataPlaneBearerToken(null);
        }

        return profile as UserProfile;
    } catch {
        setWebDataPlaneBearerToken(null);
        return null;
    }
}
