'use client'

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

function extractLegacyProjectId(pathname: string): string | null {
  const match = pathname.match(/^\/schema-projects\/([^/]+)\/?$/)
  return match?.[1] ?? null
}

export default function NotFound() {
  const router = useRouter()
  const legacyId = useMemo(() => {
    if (typeof window === 'undefined') return null
    return extractLegacyProjectId(window.location.pathname)
  }, [])

  useEffect(() => {
    if (!legacyId) return
    router.replace(`/schema-projects/designer?id=${legacyId}`)
  }, [legacyId, router])

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div>
        <p className="text-sm text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold text-foreground">
          This page could not be found
        </h1>
        <p className="text-sm text-muted-foreground">
          The link might be outdated or moved.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/schema-projects">
          <Button variant="outline">Back to projects</Button>
        </Link>
        <Link href="/">
          <Button>Go home</Button>
        </Link>
      </div>
    </main>
  )
}
