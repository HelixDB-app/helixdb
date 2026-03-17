'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SchemaDesigner } from '@/components/schema-designer'

function buildId() {
  return `project-${Date.now()}`
}

function SchemaDesignerContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [projectId, setProjectId] = useState<string | null>(null)

  const idFromQuery = useMemo(() => searchParams.get('id'), [searchParams])

  useEffect(() => {
    if (idFromQuery) {
      setProjectId(idFromQuery)
      return
    }
    const newId = buildId()
    setProjectId(newId)
    router.replace(`/schema-projects/designer?id=${newId}`)
  }, [idFromQuery, router])

  if (!projectId) return null

  return <SchemaDesigner projectId={projectId} />
}

export default function SchemaDesignerPage() {
  return (
    <Suspense fallback={null}>
      <SchemaDesignerContent />
    </Suspense>
  )
}
