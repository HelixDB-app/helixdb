'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Database,
  MoreHorizontal,
  Trash2,
  Files,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { useSchemaStore } from '@/lib/schema-store'
import { SchemaExplorer } from '@/components/schema-explorer'
import { ExportMenu } from '@/components/export-menu'
import { KeyboardHelp } from '@/components/keyboard-help'
import { ThemeToggle } from '@/components/theme-toggle'
import { MonacoSqlEditor } from '@/components/monaco-sql-editor'
import { generateSQL } from '@/lib/sql-export'
import {
  buildNewProject,
  parseSchemaSQL,
  projectToStore,
  storeToProject,
} from '@/lib/schema-designer-utils'
import {
  cacheProjectsToLocal,
  deleteLocalProject,
  loadLocalProject,
  saveLocalProject,
} from '@/lib/schema-designer-storage'
import {
  schemaDesignerDeleteProject,
  schemaDesignerGetProject,
  schemaDesignerSaveProject,
} from '@/lib/tauri'
import { isTauri } from '@/lib/tauri-runtime'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function SchemaDesigner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const {
    tables,
    relationships,
    functions,
    triggers,
    canvasItems,
    code,
    projectName,
    projectDescription,
    projectAppType,
    projectUpdatedAt,
    hydrateProject,
    setProjectMeta,
    setTables,
    setRelationships,
    setFunctions,
    setTriggers,
    setCode,
  } = useSchemaStore()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [editorValue, setEditorValue] = useState(code)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const hydratingRef = useRef(false)
  const applyingParsedRef = useRef(false)
  const lastUpdateSourceRef = useRef<'editor' | 'tables' | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (parseTimerRef.current) clearTimeout(parseTimerRef.current)
    }
  }, [])

  const applyProject = useCallback(
    (project: ReturnType<typeof projectToStore>) => {
      hydratingRef.current = true
      hydrateProject(project)
      setEditorValue(project.code)
      setParseError(null)
      requestAnimationFrame(() => {
        hydratingRef.current = false
      })
    },
    [hydrateProject]
  )

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      const local = loadLocalProject(projectId)
      if (local && !cancelled) {
        applyProject(projectToStore(local))
      }

      if (isTauri()) {
        try {
          const remote = await schemaDesignerGetProject(projectId)
          if (cancelled) return
          if (remote) {
            if (!local) {
              applyProject(projectToStore(remote))
            } else {
              const localTime = new Date(local.updated_at).getTime()
              const remoteTime = new Date(remote.updated_at).getTime()
              if (remoteTime > localTime) {
                applyProject(projectToStore(remote))
              }
            }
            saveLocalProject(remote)
          } else if (!local) {
            const fresh = buildNewProject({ id: projectId })
            applyProject(projectToStore(fresh))
            saveLocalProject(fresh)
            await schemaDesignerSaveProject(fresh)
          }
        } catch {
          if (!cancelled && local) {
            setLoadError(
              'Could not refresh this project from the app. Using your saved local copy.'
            )
          }
          if (!local && !cancelled) {
            const fresh = buildNewProject({ id: projectId })
            applyProject(projectToStore(fresh))
            saveLocalProject(fresh)
          }
        }
      } else if (!local) {
        const fresh = buildNewProject({ id: projectId })
        applyProject(projectToStore(fresh))
        saveLocalProject(fresh)
      }

      if (!cancelled) setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [applyProject, projectId])

  const scheduleSave = useCallback(() => {
    if (hydratingRef.current) return
    setDirty(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true)
      const now = new Date().toISOString()
      const current = useSchemaStore.getState()
      current.setProjectMeta({
        projectUpdatedAt: now,
        projectCreatedAt: current.projectCreatedAt ?? now,
      })
      const project = storeToProject(
        {
          projectId: current.projectId,
          projectName: current.projectName,
          projectDescription: current.projectDescription,
          projectAppType: current.projectAppType,
          projectCreatedAt: current.projectCreatedAt,
          projectUpdatedAt: current.projectUpdatedAt,
          tables: current.tables,
          relationships: current.relationships,
          functions: current.functions,
          triggers: current.triggers,
          canvasItems: current.canvasItems,
          code: current.code,
        },
        now
      )
      saveLocalProject(project)
      if (isTauri()) {
        try {
          await schemaDesignerSaveProject(project)
        } catch {
          // ignore remote save errors; local is still updated
        }
      }
      setSaving(false)
      setDirty(false)
    }, 600)
  }, [])

  useEffect(() => {
    if (loading || hydratingRef.current) return
    scheduleSave()
  }, [
    tables,
    relationships,
    code,
    projectName,
    projectDescription,
    projectAppType,
    functions,
    triggers,
    canvasItems,
    loading,
    scheduleSave,
  ])

  useEffect(() => {
    if (loading || hydratingRef.current || applyingParsedRef.current) return
    if (lastUpdateSourceRef.current === 'editor') {
      lastUpdateSourceRef.current = null
      return
    }
    const nextCode = generateSQL(tables, relationships, functions, triggers)
    if (nextCode !== code) {
      lastUpdateSourceRef.current = 'tables'
      setCode(nextCode)
      setEditorValue(nextCode)
      setParseError(null)
    }
  }, [tables, relationships, functions, triggers, code, loading, setCode])

  useEffect(() => {
    if (loading || applyingParsedRef.current) return
    if (code !== editorValue) setEditorValue(code)
  }, [code, editorValue, loading])

  const scheduleParse = useCallback((value: string) => {
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current)
    parseTimerRef.current = setTimeout(() => {
      if (!value.trim()) {
        setParseError(null)
        return
      }
      const existing = useSchemaStore.getState()
      const parsed = parseSchemaSQL(value, {
        tables: existing.tables,
        relationships: existing.relationships,
        functions: existing.functions,
        triggers: existing.triggers,
      })
      if (!parsed) {
        setParseError('Unable to parse SQL. Check syntax for CREATE TABLE.')
        return
      }
      applyingParsedRef.current = true
      setTables(parsed.tables)
      setRelationships(parsed.relationships)
      setFunctions(parsed.functions)
      setTriggers(parsed.triggers)
      setParseError(null)
      requestAnimationFrame(() => {
        applyingParsedRef.current = false
      })
    }, 350)
  }, [setFunctions, setRelationships, setTables, setTriggers])

  const handleEditorChange = useCallback(
    (value: string) => {
      lastUpdateSourceRef.current = 'editor'
      setEditorValue(value)
      setCode(value)
      scheduleParse(value)
    },
    [scheduleParse, setCode]
  )

  const handleDuplicate = useCallback(async () => {
    const now = new Date().toISOString()
    const current = useSchemaStore.getState()
    const newId = `project-${Date.now()}`
    const project = storeToProject(
      {
        projectId: newId,
        projectName: `${current.projectName || 'Untitled'} Copy`,
        projectDescription: current.projectDescription,
        projectAppType: current.projectAppType,
        projectCreatedAt: now,
        projectUpdatedAt: now,
        tables: current.tables,
        relationships: current.relationships,
        functions: current.functions,
        triggers: current.triggers,
        canvasItems: current.canvasItems,
        code: current.code,
      },
      now
    )
    saveLocalProject(project)
    if (isTauri()) {
      try {
        const list = await schemaDesignerSaveProject(project)
        cacheProjectsToLocal(list)
      } catch {
        // ignore
      }
    }
    router.push(`/schema-projects/designer?id=${newId}`)
  }, [router])

  const handleDelete = useCallback(async () => {
    deleteLocalProject(projectId)
    if (isTauri()) {
      try {
        const list = await schemaDesignerDeleteProject(projectId)
        cacheProjectsToLocal(list)
      } catch {
        // ignore
      }
    }
    router.push('/schema-projects')
  }, [projectId, router])

  const statusLabel = saving
    ? 'Saving...'
    : dirty
      ? 'Unsaved changes'
      : 'All changes saved'

  const statusVariant = saving ? 'secondary' : dirty ? 'outline' : 'secondary'

  return (
    <main className="h-screen w-screen flex flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/schema-projects">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <Database className="h-5 w-5 text-primary" />
            <Input
              value={projectName}
              onChange={(e) =>
                setProjectMeta({ projectName: e.target.value })
              }
              className="h-8 w-[220px] bg-background"
              placeholder="Project name"
            />
          </div>
          <Badge variant={statusVariant} className="hidden sm:inline-flex">
            {statusLabel}
          </Badge>
          <span className="text-xs text-muted-foreground hidden lg:inline-flex">
            Updated {formatTimestamp(projectUpdatedAt)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <ExportMenu />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleDuplicate}>
                <Files className="h-4 w-4 mr-2" />
                Duplicate project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <KeyboardHelp />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[360px] border-r border-border bg-muted/20 flex flex-col">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Schema SQL</p>
              <p className="text-xs text-muted-foreground">
                Live sync from SQL to canvas
              </p>
            </div>
            {parseError ? (
              <Badge variant="destructive">Parse error</Badge>
            ) : (
              <Badge variant="secondary">Synced</Badge>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <MonacoSqlEditor
              value={editorValue}
              onChange={handleEditorChange}
              onExecute={() => {}}
              className="h-full"
              fillHeight
              hideNextActionSuggestions
              disabled={loading}
              editorHeight={320}
            />
          </div>
          {parseError && (
            <div className="border-t border-border px-3 py-2 text-xs text-destructive">
              {parseError}
            </div>
          )}
        </aside>

        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {loading ? (
            <div className="h-full w-full overflow-auto p-6 sm:p-8">
              <div className="mx-auto max-w-5xl space-y-5">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Database className="h-5 w-5 shrink-0 text-primary" />
                  <span>Loading schema canvas…</span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div
                      key={i}
                      className="space-y-3 rounded-xl border border-border/40 bg-card/25 p-4"
                    >
                      <Skeleton className="h-8 w-[72%] rounded-md" />
                      <Skeleton className="h-3.5 w-full rounded-md" />
                      <Skeleton className="h-3.5 w-[88%] rounded-md" />
                      <Skeleton className="h-3.5 w-[55%] rounded-md" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {loadError ? (
                <Alert className="m-3 shrink-0 border-amber-500/35 bg-amber-500/[0.06]">
                  <AlertTitle className="text-sm">Offline copy</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                    <span>{loadError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-fit shrink-0"
                      onClick={() => setLoadError(null)}
                    >
                      Dismiss
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="min-h-0 flex-1">
                <FlowCanvas />
              </div>
            </div>
          )}
        </div>

        <div className="w-[300px] border-l border-border bg-muted/10 flex flex-col">
          <SchemaExplorer />
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              This removes the project and its saved schema from your device.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

const FlowCanvas = dynamic(
  () =>
    import('@/components/flow-canvas').then((mod) => ({
      default: mod.FlowCanvas,
    })),
  { ssr: false }
)
