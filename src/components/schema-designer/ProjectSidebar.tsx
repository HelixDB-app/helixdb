'use client'

import Link from 'next/link'
import { Clock3, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { getSchemaDesignerWorkspaceHref } from '@/lib/schema-designer/routes'
import { cn } from '@/lib/utils'
import type { SchemaProjectSummary } from '@/lib/schema-designer/types'

export function ProjectSidebar({
  groupedProjects,
  loading,
  query,
  onQueryChange,
  onCreate,
  activeProjectId,
}: {
  groupedProjects: Record<string, SchemaProjectSummary[]>
  loading: boolean
  query: string
  onQueryChange: (value: string) => void
  onCreate: () => void
  activeProjectId?: string | null
}) {
  return (
    <aside className="flex h-full w-full max-w-[300px] flex-col rounded-[30px] border border-white/8 bg-[#101010]/90 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl">
      <div className="mb-3 flex gap-2 rounded-[22px] border border-white/10 bg-white/5 p-1">
        <button className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white/10 px-3 py-2 text-sm font-medium text-white">
          My Projects
        </button>
        <button className="flex flex-1 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm text-zinc-500 transition hover:text-zinc-200">
          Shared
        </button>
      </div>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search projects"
          className="h-11 rounded-2xl border-white/10 bg-white/5 pl-10 text-zinc-100 placeholder:text-zinc-500"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 pr-2">
        <div className="space-y-5">
          {loading
            ? Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-4 w-24 rounded-full bg-white/10" />
                  <Skeleton className="h-16 rounded-3xl bg-white/6" />
                </div>
              ))
            : Object.entries(groupedProjects).map(([label, projects]) => (
                <div key={label} className="space-y-3">
                  <p className="px-1 text-sm font-semibold text-zinc-300">{label}</p>
                  <div className="space-y-2">
                    {projects.map((project) => (
                      <Link
                        key={project.id}
                        href={getSchemaDesignerWorkspaceHref(project.id)}
                        className={cn(
                          'flex items-start gap-3 rounded-[24px] border px-3 py-3 transition',
                          project.id === activeProjectId
                            ? 'border-white/20 bg-white/8'
                            : 'border-transparent bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.06]'
                        )}
                      >
                        <div
                          className="h-12 w-12 shrink-0 rounded-2xl border border-white/10"
                          style={{
                            background: `linear-gradient(135deg, ${project.thumbnailColor}, rgba(255,255,255,0.06))`,
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-white">{project.name}</p>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                            <Clock3 className="h-3 w-3" />
                            <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                            <span>{project.totalTables} tables</span>
                          </div>
                          {project.description ? (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">
                              {project.description}
                            </p>
                          ) : null}
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
        </div>
      </ScrollArea>

      <Button
        type="button"
        onClick={onCreate}
        className="mt-3 h-12 rounded-2xl border border-white/10 bg-white/6 text-white hover:bg-white/10"
      >
        <Plus className="mr-2 h-4 w-4" />
        New project
      </Button>
    </aside>
  )
}
