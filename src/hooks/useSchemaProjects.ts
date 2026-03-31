'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createProjectSummary,
  createSchemaDesignerProject,
} from '@/lib/schema-designer/project-utils'
import {
  deleteProject as deleteProjectRecord,
  getProject,
  listProjects,
  searchProjects,
  upsertProject,
} from '@/lib/schema-designer/mongoClient'
import type {
  SchemaDesignerDraft,
  SchemaDesignerProject,
  SchemaProjectSummary,
} from '@/lib/schema-designer/types'

export function getRecencyLabel(dateString: string): string {
  const now = new Date()
  const date = new Date(dateString)
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'Last 7 Days'
  if (diffDays < 30) return 'Last 30 Days'
  return 'Older'
}

export function useSchemaProjects(search = '') {
  const [projects, setProjects] = useState<SchemaProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = search.trim() ? await searchProjects(search) : await listProjects()
      setProjects(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load schema projects.')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const groupedProjects = useMemo(() => {
    return projects.reduce<Record<string, SchemaProjectSummary[]>>((groups, project) => {
      const label = getRecencyLabel(project.updatedAt)
      groups[label] = [...(groups[label] ?? []), project]
      return groups
    }, {})
  }, [projects])

  const createProject = useCallback(
    async (draft?: Partial<SchemaDesignerDraft> & { name?: string; description?: string }) => {
      const project = createSchemaDesignerProject(draft)
      const saved = await upsertProject(project)
      setProjects((current) => [createProjectSummary(saved), ...current.filter((entry) => entry.id !== saved.id)])
      return saved
    },
    []
  )

  const loadProject = useCallback(async (projectId: string) => getProject(projectId), [])

  const saveProject = useCallback(async (project: SchemaDesignerProject) => {
    const saved = await upsertProject(project)
    setProjects((current) => [createProjectSummary(saved), ...current.filter((entry) => entry.id !== saved.id)])
    return saved
  }, [])

  const removeProject = useCallback(async (projectId: string) => {
    await deleteProjectRecord(projectId)
    setProjects((current) => current.filter((project) => project.id !== projectId))
  }, [])

  return {
    projects,
    groupedProjects,
    loading,
    error,
    refresh,
    createProject,
    loadProject,
    saveProject,
    removeProject,
  }
}
