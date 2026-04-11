import type {
  AISchemaProject,
  AISchemaProjectSummary,
} from '@/lib/schema-designer-types'

const AI_PROJECT_LIST_KEY = 'ai-schema-projects'
const AI_PROJECT_PREFIX = 'ai-schema-project:'

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function tableCount(project: AISchemaProject): number {
  const nodes = project.schema?.react_flow_graph?.nodes ?? []
  return Array.isArray(nodes) ? nodes.length : 0
}

function toSummary(project: AISchemaProject): AISchemaProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    updated_at: project.updated_at,
    table_count: tableCount(project),
  }
}

function writeList(list: AISchemaProjectSummary[]) {
  if (!isBrowser()) return
  window.localStorage.setItem(AI_PROJECT_LIST_KEY, JSON.stringify(list))
}

export function loadAISchemaProjectSummaries(): AISchemaProjectSummary[] {
  if (!isBrowser()) return []
  const list = safeParse<AISchemaProjectSummary[]>(
    window.localStorage.getItem(AI_PROJECT_LIST_KEY),
    []
  )
  return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export function loadAISchemaProject(id: string): AISchemaProject | null {
  if (!isBrowser()) return null
  return safeParse<AISchemaProject | null>(
    window.localStorage.getItem(`${AI_PROJECT_PREFIX}${id}`),
    null
  )
}

export function saveAISchemaProject(
  project: AISchemaProject
): AISchemaProjectSummary[] {
  if (!isBrowser()) return []
  window.localStorage.setItem(
    `${AI_PROJECT_PREFIX}${project.id}`,
    JSON.stringify(project)
  )
  const summary = toSummary(project)
  const existing = loadAISchemaProjectSummaries()
  const next = [summary, ...existing.filter((item) => item.id !== project.id)]
  writeList(next)
  return next
}

export function deleteAISchemaProject(id: string): AISchemaProjectSummary[] {
  if (!isBrowser()) return []
  window.localStorage.removeItem(`${AI_PROJECT_PREFIX}${id}`)
  const next = loadAISchemaProjectSummaries().filter((item) => item.id !== id)
  writeList(next)
  return next
}
