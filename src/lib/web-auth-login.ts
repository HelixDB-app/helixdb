/**
 * Web / iPad: redirect to control-plane login with a post-login return URL.
 * pgstudio-web should redirect the browser to `return_to` / `callbackUrl` after sign-in (NextAuth often reads `callbackUrl`).
 */
import { getWebAppBaseUrl } from "@/lib/web-app-url";

const PENDING_KEY = "helix_pending_web_auth_return";

/** Query params removed from the return URL to avoid loops or leaking OAuth state. */
const STRIP_FROM_RETURN = new Set([
    "source",
    "return_to",
    "callbackUrl",
    "callback_url",
    "redirect_uri",
    "code",
    "state",
    "error",
    "error_description",
    "session_state",
    "helix_auth",
]);

/**
 * Where the control plane should send the user after login (usually your local or deployed Helix UI).
 * - `NEXT_PUBLIC_AUTH_RETURN_URL`: full URL override (e.g. `http://localhost:3000/` when dev host is a LAN IP).
 * - Otherwise: current page URL with sensitive query params stripped.
 */
export function getWebLoginReturnUrl(): string {
    if (typeof window === "undefined") return "";

    const fixed = process.env.NEXT_PUBLIC_AUTH_RETURN_URL?.trim();
    if (fixed) {
        return fixed.replace(/\/+$/, "") || window.location.origin + "/";
    }

    try {
        const u = new URL(window.location.href);
        for (const k of STRIP_FROM_RETURN) {
            u.searchParams.delete(k);
        }
        u.hash = "";
        const qs = u.searchParams.toString();
        return qs ? `${u.origin}${u.pathname}?${qs}` : `${u.origin}${u.pathname}`;
    } catch {
        return window.location.origin + "/";
    }
}

/** Full href to open on the control plane (login page). */
export function buildControlPlaneLoginHref(): string {
    const base = getWebAppBaseUrl();
    const returnUrl = typeof window !== "undefined" ? getWebLoginReturnUrl() : "";
    const q = new URLSearchParams();
    q.set("source", "web");
    if (returnUrl) {
        q.set("return_to", returnUrl);
        // NextAuth / many stacks honor this on the sign-in page
        q.set("callbackUrl", returnUrl);
    }
    return `${base}/login?${q.toString()}`;
}

/** Call immediately before navigating away to control-plane login. */
export function markPendingWebAuthReturn(): void {
    if (typeof sessionStorage === "undefined") return;
    try {
        sessionStorage.setItem(PENDING_KEY, "1");
    } catch {
        /* private mode */
    }
}

/** True once after a return from control-plane login (same origin, e.g. localhost:3000). */
export function consumePendingWebAuthReturn(): boolean {
    if (typeof sessionStorage === "undefined") return false;
    try {
        if (sessionStorage.getItem(PENDING_KEY) !== "1") return false;
        sessionStorage.removeItem(PENDING_KEY);
        return true;
    } catch {
        return false;
    }
}

export function startWebAccountLogin(): void {
    markPendingWebAuthReturn();
    window.location.href = buildControlPlaneLoginHref();
}
