const NO_INTERNET_CODE_PATTERNS = [
  "network-request-failed",
  "err_internet_disconnected",
  "eai_again",
  "enotfound",
];

const NO_INTERNET_MESSAGE_PATTERNS = [
  "failed to fetch",
  "network request failed",
  "networkerror when attempting to fetch resource",
  "the internet connection appears to be offline",
  "internet disconnected",
  "network is unreachable",
  "not connected to the internet",
  "connection appears to be offline",
  "fetch failed",
];

export const APP_OFFLINE_EVENT = "helix:offline-detected";

function extractErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toLowerCase() : "";
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }

  return String(error ?? "");
}

export function isBrowserOffline(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.onLine === false;
}

export function isNoInternetError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return false;
  }

  const code = extractErrorCode(error);
  if (
    code &&
    NO_INTERNET_CODE_PATTERNS.some((pattern) => code.includes(pattern))
  ) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  if (
    message &&
    NO_INTERNET_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))
  ) {
    return true;
  }

  return isBrowserOffline();
}

/**
 * Emits a global "offline detected" signal so UI can show a single persistent popup.
 * Returns true when the signal was emitted.
 */
export function notifyNoInternetDetected(error?: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (error !== undefined && !isNoInternetError(error)) return false;

  window.dispatchEvent(new Event(APP_OFFLINE_EVENT));
  return true;
}
