/**
 * Clipboard helpers. Prefer these over raw navigator.clipboard so we can
 * handle permission/errors in one place and stay compatible with Tauri/webview.
 */

/** Read clipboard text. Returns "" on failure or if unsupported. */
export async function readClipboardText(): Promise<string> {
    try {
        if (typeof navigator?.clipboard?.readText !== "function") return "";
        return await navigator.clipboard.readText();
    } catch {
        return "";
    }
}

/** Write text to clipboard. Returns true if successful. */
export async function writeClipboardText(text: string): Promise<boolean> {
    try {
        if (typeof navigator?.clipboard?.writeText !== "function") return false;
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
