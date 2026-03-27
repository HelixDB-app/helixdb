/** Persisted last chosen saved-connection id for desktop quick search (auto-reconnect). */
const QUICK_SEARCH_LAST_SAVED_ID_KEY = "helixdb_quick_search_last_saved_id";

export function getQuickSearchLastSavedId(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = localStorage.getItem(QUICK_SEARCH_LAST_SAVED_ID_KEY);
        return v?.trim() || null;
    } catch {
        return null;
    }
}

export function setQuickSearchLastSavedId(savedId: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (savedId) {
            localStorage.setItem(QUICK_SEARCH_LAST_SAVED_ID_KEY, savedId);
        } else {
            localStorage.removeItem(QUICK_SEARCH_LAST_SAVED_ID_KEY);
        }
    } catch {
        /* ignore quota / private mode */
    }
}
