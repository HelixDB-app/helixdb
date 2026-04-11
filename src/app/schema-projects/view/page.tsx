import { Suspense } from 'react'
import { ProjectViewClient } from './project-view-client'

function ViewFallback() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl items-center justify-center px-4 py-12">
      <p className="text-sm text-muted-foreground">Loading project…</p>
    </main>
  )
}

export default function SchemaProjectViewPage() {
  return (
    <Suspense fallback={<ViewFallback />}>
      <ProjectViewClient />
    </Suspense>
  )
}
