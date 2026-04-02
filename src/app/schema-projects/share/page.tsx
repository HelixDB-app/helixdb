'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Database, Loader2, Rocket } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { schemaSyncResolveShare } from '@/lib/schema-sync-api'
import { isSchemaSyncConfigured } from '@/lib/schema-sync-config'
import { isTauri } from '@/lib/tauri-runtime'
import { saveLocalProject } from '@/lib/schema-designer-storage'
import type { SchemaProject } from '@/lib/schema-designer-types'

function SchemaShareBody() {
  const searchParams = useSearchParams()
  const token = (searchParams.get('t') ?? searchParams.get('token') ?? '').trim()

  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState<SchemaProject | null>(null)
  const [permission, setPermission] = useState<string | null>(null)

  const openInApp = useCallback(() => {
    const u = `pgstudio://schema/share?token=${encodeURIComponent(token)}`
    window.location.href = u
  }, [token])

  const continueInBrowser = useCallback(() => {
    if (!project) return
    saveLocalProject(project)
    window.location.href = `/schema-projects/designer?id=${encodeURIComponent(project.id)}`
  }, [project])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!token) {
        setError('Invalid link — missing token.')
        setBusy(false)
        return
      }
      if (!isSchemaSyncConfigured()) {
        setError('Cloud sync is not configured for this deployment.')
        setBusy(false)
        return
      }
      try {
        const res = await schemaSyncResolveShare(token)
        if (cancelled) return
        setProject(res.project)
        setPermission(res.permission)
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : 'This share link is invalid or expired.'
          )
        }
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
        <Link href="/schema-projects">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <h1 className="text-sm font-semibold">Shared schema project</h1>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 p-6">
        {busy ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Resolving share link…</p>
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>Unable to open share</AlertTitle>
            <AlertDescription className="text-sm">{error}</AlertDescription>
          </Alert>
        ) : project ? (
          <>
            <div>
              <p className="text-lg font-semibold leading-tight">{project.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Access: <span className="font-medium">{permission}</span> ·{' '}
                {project.tables?.length ?? 0} tables
              </p>
            </div>
            <div className="flex flex-col gap-3">
              {!isTauri() ? (
                <Button type="button" className="w-full gap-2" onClick={openInApp}>
                  <Rocket className="h-4 w-4" />
                  Open in pgStudio app
                </Button>
              ) : null}
              <Button
                type="button"
                variant={isTauri() ? 'default' : 'secondary'}
                className="w-full"
                onClick={() => {
                  try {
                    continueInBrowser()
                  } catch {
                    toast.error('Could not save project locally')
                  }
                }}
              >
                {isTauri() ? 'Open in this app' : 'Continue in browser'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The desktop app registers the{' '}
              <code className="rounded bg-muted px-1">pgstudio://</code> link. If the app is not
              installed, use &quot;Continue in browser&quot; to copy the project into this site and
              open the designer.
            </p>
          </>
        ) : null}
      </main>
    </div>
  )
}

export default function SchemaShareLandingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <SchemaShareBody />
    </Suspense>
  )
}
