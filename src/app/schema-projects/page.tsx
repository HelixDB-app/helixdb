'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Database, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
import { ThemeToggle } from '@/components/theme-toggle'
import { isTauri } from '@/lib/tauri-runtime'
import {
  cacheProjectsToLocal,
  deleteLocalProject,
  loadLocalProjectSummaries,
  saveLocalProject,
} from '@/lib/schema-designer-storage'
import {
  schemaDesignerDeleteProject,
  schemaDesignerLoadAll,
  schemaDesignerSaveProject,
} from '@/lib/tauri'
import { buildNewProject, projectToSummary } from '@/lib/schema-designer-utils'
import type { SchemaProjectSummary } from '@/lib/schema-designer-types'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

export default function SchemaProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<SchemaProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SchemaProjectSummary | null>(
    null
  )

  useEffect(() => {
    const local = loadLocalProjectSummaries()
    setProjects(local)
    if (isTauri()) {
      schemaDesignerLoadAll()
        .then((list) => {
          const summaries = cacheProjectsToLocal(list)
          setProjects(summaries)
        })
        .catch(() => {
          // keep local list
        })
    }
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

  const handleCreate = async () => {
    const newId = `project-${Date.now()}`
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

  return (
    <main className="min-h-screen bg-transparent">
      <header className="border-b border-border bg-muted/40 px-6 py-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">

{/* add a back button */}
<Link href="/">
<Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.back()}>
  <ArrowLeft className="h-4 w-4" />
</Button>
</Link>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold text-foreground">
                Schema Projects
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Build, version, and export database designs.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects..."
              className="h-9 w-[220px]"
            />
            <ThemeToggle />
            <Button onClick={handleCreate} className="gap-2">
              <Plus className="h-4 w-4" />
              New project
            </Button>
          </div>
        </div>
      </header>

      <section className="px-6 py-6">
        {filtered.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-10 text-center">
            <Database className="h-10 w-10 text-muted-foreground mx-auto" />
            <h2 className="mt-4 text-base font-semibold text-foreground">
              No schema projects yet
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Start with a new project and design your database visually.
            </p>
            <Button onClick={handleCreate} className="mt-4">
              Create your first project
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((project) => (
              <Card key={project.id} className="group">
                <CardHeader className="flex flex-row items-start justify-between space-y-0">
                  <div className="space-y-1">
                    <h3 className="text-base font-semibold text-foreground">
                      {project.name}
                    </h3>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {project.description || 'No description added'}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/schema-projects/designer?id=${project.id}`}>
                          Open project
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget(project)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary">
                      {project.table_count} tables
                    </Badge>
                    <span>Updated {formatDate(project.updated_at)}</span>
                  </div>
                  <Link href={`/schema-projects/designer?id=${project.id}`}>
                    <Button variant="outline" className="w-full">
                      Open designer
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

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
