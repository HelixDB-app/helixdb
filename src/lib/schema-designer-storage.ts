import type { SchemaProject, SchemaProjectSummary } from '@/lib/schema-designer-types'
import { projectToSummary } from '@/lib/schema-designer-utils'

const PROJECT_LIST_KEY = 'schema-designer-projects'
const PROJECT_PREFIX = 'schema-designer-project:'

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

export function loadLocalProjectSummaries(): SchemaProjectSummary[] {
  if (!isBrowser()) return []
  const list = safeParse<SchemaProjectSummary[]>(
    window.localStorage.getItem(PROJECT_LIST_KEY),
    []
  )
  return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export function loadLocalProject(id: string): SchemaProject | null {
  if (!isBrowser()) return null
  return safeParse<SchemaProject | null>(
    window.localStorage.getItem(`${PROJECT_PREFIX}${id}`),
    null
  )
}

function saveProjectSummaries(list: SchemaProjectSummary[]) {
  if (!isBrowser()) return
  window.localStorage.setItem(PROJECT_LIST_KEY, JSON.stringify(list))
}

export function saveLocalProject(project: SchemaProject): SchemaProjectSummary[] {
  if (!isBrowser()) return []
  window.localStorage.setItem(
    `${PROJECT_PREFIX}${project.id}`,
    JSON.stringify(project)
  )
  const summary = projectToSummary(project)
  const list = loadLocalProjectSummaries()
  const next = [summary, ...list.filter((p) => p.id !== project.id)]
  saveProjectSummaries(next)
  return next
}

export function deleteLocalProject(id: string): SchemaProjectSummary[] {
  if (!isBrowser()) return []
  window.localStorage.removeItem(`${PROJECT_PREFIX}${id}`)
  const next = loadLocalProjectSummaries().filter((p) => p.id !== id)
  saveProjectSummaries(next)
  return next
}

export function cacheProjectsToLocal(projects: SchemaProject[]): SchemaProjectSummary[] {
  if (!isBrowser()) return []
  const summaries = projects
    .map(projectToSummary)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  saveProjectSummaries(summaries)
  for (const project of projects) {
    window.localStorage.setItem(
      `${PROJECT_PREFIX}${project.id}`,
      JSON.stringify(project)
    )
  }
  return summaries
}
