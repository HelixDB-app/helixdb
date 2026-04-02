import { schemaSyncHttpBase } from '@/lib/schema-sync-config'
import type { SchemaProject } from '@/lib/schema-designer-types'

function base(): string {
  const b = schemaSyncHttpBase()
  if (!b) throw new Error('Schema sync HTTP URL not configured')
  return b
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

export async function schemaSyncListProjects(token: string): Promise<
  Array<{ id: string; name: string; updated_at: string; revision: number }>
> {
  const res = await fetch(`${base()}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`list projects ${res.status}`)
  return (await res.json()) as Array<{
    id: string
    name: string
    updated_at: string
    revision: number
  }>
}

export async function schemaSyncGetProject(
  token: string,
  projectId: string
): Promise<{ project: SchemaProject; revision: number }> {
  const res = await fetch(`${base()}/v1/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`get project ${res.status}`)
  const j = (await res.json()) as { project: SchemaProject; revision: number }
  return j
}

export async function schemaSyncCreateProject(
  token: string,
  project: SchemaProject
): Promise<{ id: string; revision: number }> {
  const res = await fetch(`${base()}/v1/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ project }),
  })
  if (!res.ok) {
    const err = await parseJson(res)
    throw new Error(`create project ${res.status}: ${JSON.stringify(err)}`)
  }
  return (await res.json()) as { id: string; revision: number }
}

export async function schemaSyncPatchProject(
  token: string,
  projectId: string,
  body: {
    base_revision: number
    client_op_id: string
    project: SchemaProject
  }
): Promise<unknown> {
  const res = await fetch(`${base()}/v1/projects/${projectId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const j = await parseJson(res)
  if (!res.ok) {
    throw new Error(`patch ${res.status}: ${JSON.stringify(j)}`)
  }
  return j
}

export async function schemaSyncCreateShareLink(
  token: string,
  projectId: string,
  permission: 'viewer' | 'editor'
): Promise<{ token: string; permission: string; project_id: string }> {
  const res = await fetch(`${base()}/v1/projects/${projectId}/share`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permission }),
  })
  if (!res.ok) throw new Error(`share ${res.status}`)
  return (await res.json()) as {
    token: string
    permission: string
    project_id: string
  }
}

export async function schemaSyncResolveShare(
  shareToken: string
): Promise<{
  project_id: string
  permission: string
  project: SchemaProject
  revision: number
}> {
  const res = await fetch(`${base()}/v1/share/${encodeURIComponent(shareToken)}/resolve`)
  if (!res.ok) throw new Error(`resolve share ${res.status}`)
  return (await res.json()) as {
    project_id: string
    permission: string
    project: SchemaProject
    revision: number
  }
}
