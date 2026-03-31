export function getSchemaDesignerWorkspaceHref(projectId: string): string {
  return `/schema-designer/workspace?projectId=${encodeURIComponent(projectId)}`
}
