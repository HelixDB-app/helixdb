export function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__)
}
