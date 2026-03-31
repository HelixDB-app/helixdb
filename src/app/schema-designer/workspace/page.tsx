import { Suspense } from 'react'
import { SchemaDesignerWorkspaceRoute } from '@/components/schema-designer/SchemaDesignerWorkspaceRoute'

function WorkspaceFallback() {
  return <div className="min-h-dvh bg-[#090909]" />
}

export default function SchemaDesignerWorkspacePage() {
  return (
    <Suspense fallback={<WorkspaceFallback />}>
      <SchemaDesignerWorkspaceRoute />
    </Suspense>
  )
}
