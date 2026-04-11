'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, MoreHorizontal, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { ThemeToggle } from '@/components/theme-toggle'
import {
  deleteAISchemaProject,
  loadAISchemaProjectSummaries,
} from '@/lib/ai-schema-project-storage'
import { aiSchemaViewHref } from '@/lib/ai-schema-routes'
import type { AISchemaProjectSummary } from '@/lib/schema-designer-types'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

export default function SchemaProjectsPage() {
  const [projects, setProjects] = useState<AISchemaProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<AISchemaProjectSummary | null>(null)

  useEffect(() => {
    setProjects(loadAISchemaProjectSummaries())
    const onFocus = () => setProjects(loadAISchemaProjectSummaries())
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const filtered = useMemo(() => {
    if (!query.trim()) return projects
    const q = query.trim().toLowerCase()
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
    )
  }, [projects, query])

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const next = deleteAISchemaProject(deleteTarget.id)
    setProjects(next)
    setDeleteTarget(null)
  }

  const projectHref = (id: string) => aiSchemaViewHref(id)

  return (
    <main className="flex min-h-dvh flex-col bg-background">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/40 bg-muted/40 backdrop-blur-md supports-[backdrop-filter]:bg-muted/30">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <Link href="/">
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Back to home">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg font-semibold tracking-tight text-foreground">
                    AI Schema Projects
                  </h1>
                </div>
                <p className="text-sm text-muted-foreground">
                  All generated schemas are stored locally on this device.
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
              <Button asChild className="gap-2">
                <Link href="/schema-projects/ai-designer">
                  <Sparkles className="h-4 w-4" />
                  Generate with AI
                </Link>
              </Button>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 sm:px-6">
            <section className="animate-in fade-in slide-in-from-bottom-2 pb-8 pt-6 duration-300">
              {projects.length === 0 ? (
                  <Card className="border-dashed border-border/50 bg-card/30 py-12 text-center shadow-none animate-in fade-in zoom-in-95 duration-300">
                    <CardContent className="space-y-4 pt-6">
                      <h2 className="text-base font-semibold text-foreground">
                        No AI schema projects yet
                      </h2>
                      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                        Generate your first schema with AI and it will appear here.
                      </p>
                      <Button asChild><Link href="/schema-projects/ai-designer">Generate now</Link></Button>
                    </CardContent>
                  </Card>
                ) : filtered.length === 0 ? (
                  <Card className="border-dashed border-border/50 bg-card/30 py-12 text-center shadow-none animate-in fade-in zoom-in-95 duration-300">
                    <CardContent className="space-y-4 pt-6">
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
                        className="group overflow-hidden border-border/40 bg-card/40 transition-all duration-300 hover:border-primary/25 hover:shadow-md animate-in fade-in slide-in-from-bottom-2"
                      >
                        <CardHeader className="flex flex-row items-start gap-2 space-y-0 pb-3">
                          <Link
                            href={projectHref(project.id)}
                            className="min-w-0 flex-1 rounded-md outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                                className="h-8 w-8 shrink-0 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                aria-label={`Actions for ${project.name}`}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem asChild>
                                <Link href={projectHref(project.id)}>Open project</Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setDeleteTarget(project)} className="text-destructive focus:text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" /> Delete
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
                            <Link href={projectHref(project.id)}>Open project</Link>
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
            </section>
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
  )
}
