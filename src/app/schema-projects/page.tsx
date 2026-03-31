'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  Database,
  Files,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'
import { isTauri } from '@/lib/tauri-runtime'
import {
  cacheProjectsToLocal,
  deleteLocalProject,
  loadLocalProject,
  loadLocalProjectSummaries,
  saveLocalProject,
} from '@/lib/schema-designer-storage'
import {
  schemaDesignerDeleteProject,
  schemaDesignerLoadAll,
  schemaDesignerSaveProject,
} from '@/lib/tauri'
import {
  buildNewProject,
  projectToStore,
  projectToSummary,
  storeToProject,
} from '@/lib/schema-designer-utils'
import type { SchemaProjectSummary } from '@/lib/schema-designer-types'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

function createProjectId(): string {
  return `project-${Date.now()}`
}

type SyncStatus = 'idle' | 'syncing' | 'error'

export default function SchemaProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<SchemaProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SchemaProjectSummary | null>(
    null
  )
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setProjects(loadLocalProjectSummaries())
    })
    return () => cancelAnimationFrame(id)
  }, [])

  const runRemoteSync = useCallback(() => {
    if (!isTauri()) return
    setSyncStatus('syncing')
    setSyncError(null)
    schemaDesignerLoadAll()
      .then((list) => {
        const summaries = cacheProjectsToLocal(list)
        setProjects(summaries)
        setSyncStatus('idle')
      })
      .catch(() => {
        setSyncStatus('error')
        setSyncError('Could not sync projects from the app runtime.')
      })
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const id = requestAnimationFrame(() => {
      runRemoteSync()
    })
    return () => cancelAnimationFrame(id)
  }, [runRemoteSync])

  const filtered = useMemo(() => {
    if (!query.trim()) return projects
    const q = query.trim().toLowerCase()
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
    )
  }, [projects, query])

  const showSyncSkeleton =
    isTauri() && syncStatus === 'syncing' && projects.length === 0

  const handleCreate = async () => {
    const newId = createProjectId()
    const project = buildNewProject({ id: newId })
    saveLocalProject(project)
    setProjects((prev) => [projectToSummary(project), ...prev])
    if (isTauri()) {
      try {
        const list = await schemaDesignerSaveProject(project)
        setProjects(cacheProjectsToLocal(list))
      } catch {
        // ignore
      }
    }
    router.push(`/schema-projects/designer?id=${newId}`)
  }

  const handleDuplicateProject = async (summary: SchemaProjectSummary) => {
    const source = loadLocalProject(summary.id)
    if (!source) {
      toast.error('Could not load project data.')
      return
    }
    const now = new Date().toISOString()
    const newId = createProjectId()
    const store = projectToStore(source)
    const dup = storeToProject(
      {
        ...store,
        projectId: newId,
        projectName: `${store.projectName?.trim() || 'Untitled'} Copy`,
        projectDescription: store.projectDescription,
        projectAppType: store.projectAppType,
        projectCreatedAt: now,
        projectUpdatedAt: now,
      },
      now
    )
    const next = saveLocalProject(dup)
    setProjects(next)
    if (isTauri()) {
      try {
        const list = await schemaDesignerSaveProject(dup)
        setProjects(cacheProjectsToLocal(list))
      } catch {
        toast.error('Project was saved locally but could not sync to the app.')
      }
    }
    router.push(`/schema-projects/designer?id=${newId}`)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    deleteLocalProject(deleteTarget.id)
    setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id))
    if (isTauri()) {
      try {
        const list = await schemaDesignerDeleteProject(deleteTarget.id)
        setProjects(cacheProjectsToLocal(list))
      } catch {
        // ignore
      }
    }
    setDeleteTarget(null)
  }

  const designerHref = (id: string) =>
    `/schema-projects/designer?id=${encodeURIComponent(id)}`

  return (
    <TooltipProvider delayDuration={300}>
      <main className="flex min-h-dvh flex-col bg-background">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/40 bg-muted/40 backdrop-blur-md supports-[backdrop-filter]:bg-muted/30">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      aria-label="Back to home"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom">Back to home</TooltipContent>
              </Tooltip>
              <Separator
                orientation="vertical"
                className="hidden h-10 sm:block"
              />
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Database className="h-5 w-5 shrink-0 text-primary" />
                  <h1 className="text-lg font-semibold tracking-tight text-foreground">
                    Schema Projects
                  </h1>
                  {syncStatus === 'syncing' ? (
                    <Badge variant="outline" className="font-normal">
                      Syncing…
                    </Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  Build, version, and export database designs.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects…"
                className="h-9 min-w-[min(100%,12rem)] flex-1 sm:w-[220px] sm:flex-none"
                aria-label="Search projects"
              />
              <ThemeToggle />
              <Button onClick={handleCreate} className="gap-2">
                <Plus className="h-4 w-4" />
                New project
              </Button>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 sm:px-6">
            {syncError ? (
              <Alert
                variant="destructive"
                className="mt-4 shrink-0 animate-in fade-in zoom-in-95 duration-200"
              >
                <AlertCircle className="size-4" />
                <AlertTitle>Sync failed</AlertTitle>
                <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>{syncError}</span>
                  {isTauri() ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit border-destructive/40 bg-background"
                      onClick={() => runRemoteSync()}
                    >
                      Retry
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <ScrollArea className="min-h-0 flex-1">
              <section
                className={cn(
                  'animate-in fade-in slide-in-from-bottom-2 pb-8 pt-6 duration-300',
                  'pr-3'
                )}
              >
                {showSyncSkeleton ? (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {[0, 1, 2].map((i) => (
                      <Card
                        key={i}
                        className="border-border/40 bg-card/40 overflow-hidden"
                      >
                        <CardHeader className="space-y-2">
                          <Skeleton className="h-5 w-2/3" />
                          <Skeleton className="h-3 w-full" />
                          <Skeleton className="h-3 w-4/5" />
                        </CardHeader>
                        <CardContent className="space-y-3 pt-0">
                          <div className="flex gap-2">
                            <Skeleton className="h-5 w-20 rounded-full" />
                            <Skeleton className="h-4 w-28" />
                          </div>
                          <Skeleton className="h-8 w-full rounded-md" />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : projects.length === 0 ? (
                  <Card className="border-dashed border-border/50 bg-card/30 py-12 text-center shadow-none animate-in fade-in zoom-in-95 duration-300">
                    <CardContent className="space-y-4 pt-6">
                      <Database className="mx-auto h-10 w-10 text-muted-foreground" />
                      <h2 className="text-base font-semibold text-foreground">
                        No schema projects yet
                      </h2>
                      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                        Start with a new project and design your database
                        visually.
                      </p>
                      <Button onClick={handleCreate}>
                        Create your first project
                      </Button>
                    </CardContent>
                  </Card>
                ) : filtered.length === 0 ? (
                  <Card className="border-dashed border-border/50 bg-card/30 py-12 text-center shadow-none animate-in fade-in zoom-in-95 duration-300">
                    <CardContent className="space-y-4 pt-6">
                      <Database className="mx-auto h-10 w-10 text-muted-foreground" />
                      <h2 className="text-base font-semibold text-foreground">
                        No projects match your search
                      </h2>
                      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                        Try a different term or clear the filter to see all
                        projects.
                      </p>
                      <Button variant="outline" onClick={() => setQuery('')}>
                        Clear search
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((project, i) => (
                      <Card
                        key={project.id}
                        style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                        className={cn(
                          'group border-border/40 bg-card/40 overflow-hidden',
                          'transition-all duration-300',
                          'hover:border-primary/25 hover:shadow-md',
                          'animate-in fade-in slide-in-from-bottom-2 duration-300'
                        )}
                      >
                        <CardHeader className="flex flex-row items-start gap-2 space-y-0 pb-3">
                          <Link
                            href={designerHref(project.id)}
                            className={cn(
                              'min-w-0 flex-1 rounded-md outline-none',
                              'ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                            )}
                          >
                            <h3 className="text-base font-semibold leading-snug text-foreground">
                              {project.name}
                            </h3>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {project.description || 'No description added'}
                            </p>
                          </Link>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  'h-8 w-8 shrink-0',
                                  'opacity-100',
                                  'sm:opacity-0 sm:transition-opacity',
                                  'sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
                                )}
                                aria-label={`Actions for ${project.name}`}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem asChild>
                                <Link href={designerHref(project.id)}>
                                  Open project
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  void handleDuplicateProject(project)
                                }
                              >
                                <Files className="mr-2 h-4 w-4" />
                                Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setDeleteTarget(project)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </CardHeader>
                        <CardContent className="space-y-3 pt-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <Badge variant="secondary" className="font-normal">
                              {project.table_count} tables
                            </Badge>
                            <span className="text-muted-foreground/90">
                              Updated {formatDate(project.updated_at)}
                            </span>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            className="w-full"
                            asChild
                          >
                            <Link href={designerHref(project.id)}>
                              Open designer
                            </Link>
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </section>
            </ScrollArea>
          </div>
        </div>

        <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete project?</DialogTitle>
              <DialogDescription>
                This removes the project and its saved schema from your device.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmDelete}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  )
}
