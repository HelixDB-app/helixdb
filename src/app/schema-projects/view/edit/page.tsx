import { Suspense } from 'react'
import { ProjectEditClient } from './project-edit-client'

function EditFallback() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl items-center justify-center px-4 py-12">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </main>
  )
}

export default function SchemaProjectEditPage() {
  return (
    <Suspense fallback={<EditFallback />}>
      <ProjectEditClient />
    </Suspense>
  )
}
