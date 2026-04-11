/**
 * Static-export friendly routes: no `[id]` path segments (IDs are runtime-only from localStorage).
 * Use with `trailingSlash: true` in next.config — paths include trailing slash before `?`.
 */
export function aiSchemaViewHref(id: string): string {
  return `/schema-projects/view/?id=${encodeURIComponent(id)}`
}

export function aiSchemaEditHref(id: string): string {
  return `/schema-projects/view/edit/?id=${encodeURIComponent(id)}`
}
