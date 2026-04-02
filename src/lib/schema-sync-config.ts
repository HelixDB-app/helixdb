/** Public sync service URLs (browser / Tauri webview). No secrets. */

export function schemaSyncHttpBase(): string | null {
  const u = process.env.NEXT_PUBLIC_SCHEMA_SYNC_HTTP_URL?.trim()
  return u && u.length > 0 ? u.replace(/\/$/, '') : null
}

export function schemaSyncWsBase(): string | null {
  const u = process.env.NEXT_PUBLIC_SCHEMA_SYNC_WS_URL?.trim()
  return u && u.length > 0 ? u.replace(/\/$/, '') : null
}

export function isSchemaSyncConfigured(): boolean {
  return !!(schemaSyncHttpBase() && schemaSyncWsBase())
}
