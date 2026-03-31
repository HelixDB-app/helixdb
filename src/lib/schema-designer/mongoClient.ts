'use client'

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/tauri-runtime'
import { PROJECT_STORAGE_NAMESPACE } from '@/lib/schema-designer/constants'
import {
  createProjectSummary,
  updateProjectTimestamp,
} from '@/lib/schema-designer/project-utils'
import type {
  ApiKeyRecord,
  SchemaDesignerProject,
  SchemaProjectSummary,
} from '@/lib/schema-designer/types'

const PROJECTS_KEY = `${PROJECT_STORAGE_NAMESPACE}:projects`

function localStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function loadLocalProjects(): SchemaDesignerProject[] {
  if (!localStorageAvailable()) return []
  const raw = window.localStorage.getItem(PROJECTS_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as SchemaDesignerProject[]
  } catch {
    return []
  }
}

function saveLocalProjects(projects: SchemaDesignerProject[]) {
  if (!localStorageAvailable()) return
  window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
}

function sortProjects(projects: SchemaDesignerProject[]): SchemaDesignerProject[] {
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listProjects(): Promise<SchemaProjectSummary[]> {
  if (isTauri()) {
    return invoke<SchemaProjectSummary[]>('schema_designer_v2_list_projects')
  }
  return sortProjects(loadLocalProjects()).map(createProjectSummary)
}

export async function searchProjects(query: string): Promise<SchemaProjectSummary[]> {
  if (isTauri()) {
    return invoke<SchemaProjectSummary[]>('schema_designer_v2_search_projects', { query })
  }
  const normalized = query.trim().toLowerCase()
  return sortProjects(loadLocalProjects())
    .filter((project) => {
      if (!normalized) return true
      const conversationText = project.conversation
        .map((message) => message.content)
        .join(' ')
        .toLowerCase()
      const schemaText = JSON.stringify(project.schema ?? '').toLowerCase()
      return (
        project.name.toLowerCase().includes(normalized) ||
        project.description.toLowerCase().includes(normalized) ||
        project.prompt.toLowerCase().includes(normalized) ||
        conversationText.includes(normalized) ||
        schemaText.includes(normalized)
      )
    })
    .map(createProjectSummary)
}

export async function getProject(projectId: string): Promise<SchemaDesignerProject | null> {
  if (isTauri()) {
    return invoke<SchemaDesignerProject | null>('schema_designer_v2_get_project', {
      projectId,
    })
  }
  return loadLocalProjects().find((project) => project.id === projectId) ?? null
}

export async function upsertProject(
  project: SchemaDesignerProject
): Promise<SchemaDesignerProject> {
  const nextProject = updateProjectTimestamp(project)
  if (isTauri()) {
    return invoke<SchemaDesignerProject>('schema_designer_v2_upsert_project', {
      project: nextProject,
    })
  }
  const projects = loadLocalProjects()
  const next = [...projects.filter((entry) => entry.id !== nextProject.id), nextProject]
  saveLocalProjects(sortProjects(next))
  return nextProject
}

export async function deleteProject(projectId: string): Promise<void> {
  if (isTauri()) {
    await invoke('schema_designer_v2_delete_project', { projectId })
    return
  }
  const next = loadLocalProjects().filter((project) => project.id !== projectId)
  saveLocalProjects(next)
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  if (isTauri()) {
    return invoke<ApiKeyRecord[]>('schema_designer_v2_list_api_keys')
  }
  return []
}

export async function saveApiKey(
  label: string,
  value: string,
  makeDefault = true
): Promise<ApiKeyRecord[]> {
  if (!isTauri()) {
    throw new Error('Secure API key storage is available only in the desktop app.')
  }
  return invoke<ApiKeyRecord[]>('schema_designer_v2_store_api_key', {
    label,
    value,
    makeDefault,
  })
}

export async function deleteApiKey(apiKeyId: string): Promise<ApiKeyRecord[]> {
  if (!isTauri()) {
    throw new Error('Secure API key storage is available only in the desktop app.')
  }
  return invoke<ApiKeyRecord[]>('schema_designer_v2_delete_api_key', { apiKeyId })
}
