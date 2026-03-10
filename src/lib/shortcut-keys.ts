/**
 * Keyboard shortcut handling: normalize combo strings and format for display.
 * Combo format: "Mod+Shift+Key" (Mod = Cmd on Mac, Ctrl on Win/Linux).
 */

/** True if the event target is an editable control; global shortcuts should not run. */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || !(target instanceof Node)) return false;
    const el = target as HTMLElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
    if (el.isContentEditable) return true;
    // Monaco and other code editors: focus is inside a wrapper, not always contenteditable
    if (el.closest?.(".monaco-editor, [data-monaco-editor]")) return true;
    const role = el.getAttribute?.("role");
    if (role === "textbox" || role === "searchbox") return true;
    return false;
}

const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** Build a normalized combo string from a KeyboardEvent (e.g. "Mod+Shift+K"). */
export function eventToCombo(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("Mod");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (key && key !== "Meta" && key !== "Control" && key !== "Alt" && key !== "Shift")
        parts.push(key);
    return parts.join("+");
}

/** Check if a KeyboardEvent matches a stored combo string. */
export function eventMatchesCombo(e: KeyboardEvent, combo: string): boolean {
    const normalized = eventToCombo(e);
    return normalizeCombo(combo) === normalized;
}

/** Normalize a combo string for comparison (Mod+shift+K -> Mod+Shift+K). */
export function normalizeCombo(combo: string): string {
    return combo
        .split("+")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
            const lower = p.toLowerCase();
            if (lower === "mod") return "Mod";
            if (lower === "shift") return "Shift";
            if (lower === "alt") return "Alt";
            if (p.length === 1) return p.toUpperCase();
            return p;
        })
        .join("+");
}

/** Format a combo string for display (e.g. "Mod+Shift+R" -> "⌘⇧R" on Mac). */
export function formatShortcut(combo: string): string {
    if (!combo) return "";
    const parts = normalizeCombo(combo).split("+");
    const symbols: string[] = [];
    for (const p of parts) {
        if (p === "Mod") symbols.push(isMac ? "⌘" : "Ctrl");
        else if (p === "Shift") symbols.push("⇧");
        else if (p === "Alt") symbols.push("⌥");
        else symbols.push(p);
    }
    return symbols.join("");
}

/** Format as separate kbd tokens for UI (e.g. ["⌘", "⇧", "R"]). */
export function formatShortcutKeys(combo: string): string[] {
    if (!combo) return [];
    const parts = normalizeCombo(combo).split("+");
    const symbols: string[] = [];
    for (const p of parts) {
        if (p === "Mod") symbols.push(isMac ? "⌘" : "Ctrl");
        else if (p === "Shift") symbols.push("⇧");
        else if (p === "Alt") symbols.push("⌥");
        else symbols.push(p);
    }
    return symbols;
}
