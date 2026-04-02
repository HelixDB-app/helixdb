'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTauri } from '@/lib/tauri-runtime'
import {
  schemaSyncCreateProject,
  schemaSyncCreateShareLink,
  schemaSyncGetProject,
  schemaSyncPatchProject,
} from '@/lib/schema-sync-api'
import {
  idbEnqueueOutbox,
  idbListOutbox,
  idbPutProjectCache,
  idbRemoveOutboxIds,
} from '@/lib/schema-sync-idb'
import { isSchemaSyncConfigured, schemaSyncWsBase } from '@/lib/schema-sync-config'
import type { SchemaProject } from '@/lib/schema-designer-types'
import { runtimeAuthGetToken } from '@/lib/auth-runtime'
import {
  schemaSyncLocalEnqueue,
  schemaSyncLocalPutCache,
} from '@/lib/tauri'

export type SchemaSyncStatus =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'synced'
  | 'saving'
  | 'pending_offline'
  | 'error'

export type RemotePresence = {
  userId: string
  x: number
  y: number
  nodeId: string
  at: number
}

function newClientOpId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function mirrorLocalCache(
  projectId: string,
  json: string,
  revision: number
): Promise<void> {
  await idbPutProjectCache({
    projectId,
    json,
    revision,
    updatedAt: new Date().toISOString(),
  })
  if (isTauri()) {
    try {
      await schemaSyncLocalPutCache(projectId, json, revision)
    } catch {
      /* optional */
    }
  }
}

async function mirrorOutbox(
  projectId: string,
  payload: string,
  clientOpId: string
): Promise<void> {
  await idbEnqueueOutbox({
    projectId,
    payload,
    clientOpId,
    createdAt: new Date().toISOString(),
  })
  if (isTauri()) {
    try {
      await schemaSyncLocalEnqueue(projectId, payload, clientOpId)
    } catch {
      /* optional */
    }
  }
}

export type UseSchemaSyncOptions = {
  projectId: string | null
  /** Signed-in + configured */
  enabled: boolean
  /** Omit others' cursors matching this `sub` */
  localUserId?: string | null
  getProject: () => SchemaProject
  /** Apply server document; should set store without re-firing endless sync */
  applyRemoteProject: (project: SchemaProject) => void
}

export function useSchemaSync({
  projectId,
  enabled,
  localUserId,
  getProject,
  applyRemoteProject,
}: UseSchemaSyncOptions) {
  const [status, setStatus] = useState<SchemaSyncStatus>('disabled')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [remotePresence, setRemotePresence] = useState<RemotePresence[]>([])
  const revisionRef = useRef(0)
  const wsRef = useRef<WebSocket | null>(null)
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreLocalUntilRef = useRef(0)
  const presenceThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPresenceRef = useRef({ x: 0, y: 0, nodeId: '' })

  const configured = useMemo(() => isSchemaSyncConfigured(), [])

  const closeWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  const pushViaHttp = useCallback(
    async (token: string, project: SchemaProject, baseRev: number, opId: string) => {
      const pid = project.id
      const res = (await schemaSyncPatchProject(token, pid, {
        base_revision: baseRev,
        client_op_id: opId,
        project,
      })) as {
        ok?: boolean
        conflict?: boolean
        revision?: number
        project?: SchemaProject
        dedup?: boolean
      }
      if (res.conflict && res.project && typeof res.revision === 'number') {
        ignoreLocalUntilRef.current = Date.now() + 800
        applyRemoteProject(res.project)
        revisionRef.current = res.revision
        await mirrorLocalCache(pid, JSON.stringify(res.project), res.revision)
        setStatus('error')
        setErrorMessage('Server had a newer version — merged remote copy.')
        return
      }
      if (res.ok && res.project && typeof res.revision === 'number') {
        revisionRef.current = res.revision
        await mirrorLocalCache(pid, JSON.stringify(res.project), res.revision)
        setStatus('synced')
        setErrorMessage(null)
      }
    },
    [applyRemoteProject]
  )

  const flushOnePush = useCallback(async () => {
    if (!projectId || !enabled || !configured) return
    const token = await runtimeAuthGetToken()
    if (!token) {
      setStatus('disabled')
      return
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('pending_offline')
      return
    }
    const project = getProject()
    if (project.id !== projectId) return
    const opId = newClientOpId()
    const payload = JSON.stringify({
      base_revision: revisionRef.current,
      client_op_id: opId,
      project,
    })
    setStatus('saving')
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'push',
            base_revision: revisionRef.current,
            client_op_id: opId,
            project,
          })
        )
        return
      }
      await pushViaHttp(token, project, revisionRef.current, opId)
    } catch (e) {
      setStatus('pending_offline')
      setErrorMessage(e instanceof Error ? e.message : 'Sync failed')
      await mirrorOutbox(projectId, payload, opId)
    }
  }, [projectId, enabled, configured, getProject, pushViaHttp])

  const schedulePush = useCallback(() => {
    if (!enabled || !configured || !projectId) return
    if (Date.now() < ignoreLocalUntilRef.current) return
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null
      void flushOnePush()
    }, 450)
  }, [enabled, configured, projectId, flushOnePush])

  useEffect(() => {
    if (!enabled || !configured || !projectId) {
      closeWs()
      return
    }

    let cancelled = false

    async function bootstrap() {
      setStatus('connecting')
      setErrorMessage(null)
      const token = await runtimeAuthGetToken()
      if (!token || cancelled) {
        setStatus('disabled')
        return
      }
      try {
        try {
          const got = await schemaSyncGetProject(token, projectId)
          revisionRef.current = got.revision
          await mirrorLocalCache(projectId, JSON.stringify(got.project), got.revision)
          ignoreLocalUntilRef.current = Date.now() + 500
          applyRemoteProject(got.project)
        } catch {
          const proj = getProject()
          if (proj.id === projectId) {
            const created = await schemaSyncCreateProject(token, proj)
            revisionRef.current = created.revision
            await mirrorLocalCache(projectId, JSON.stringify(proj), created.revision)
          }
        }

        const wsBase = schemaSyncWsBase()
        if (!wsBase || cancelled) return
        const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}`
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          if (cancelled) return
          ws.send(JSON.stringify({ type: 'subscribe', project_id: projectId }))
          setStatus('synced')
          void (async () => {
            const pending = await idbListOutbox(projectId)
            const tok = await runtimeAuthGetToken()
            if (!tok || pending.length === 0) return
            for (const row of pending) {
              if (cancelled) return
              try {
                const body = JSON.parse(row.payload) as {
                  base_revision: number
                  client_op_id: string
                  project: SchemaProject
                }
                await schemaSyncPatchProject(tok, projectId, {
                  base_revision: body.base_revision,
                  client_op_id: body.client_op_id,
                  project: body.project,
                })
                if (row.id != null) await idbRemoveOutboxIds([row.id])
              } catch {
                break
              }
            }
          })()
        }

        ws.onmessage = (ev) => {
          if (cancelled) return
          try {
            const msg = JSON.parse(String(ev.data)) as Record<string, unknown>
            const t = msg.type as string
            if (t === 'snapshot' && msg.project && typeof msg.revision === 'number') {
              const proj = msg.project as SchemaProject
              const rev = msg.revision as number
              if (rev !== revisionRef.current) {
                ignoreLocalUntilRef.current = Date.now() + 600
                applyRemoteProject(proj)
                revisionRef.current = rev
                void mirrorLocalCache(projectId, JSON.stringify(proj), rev)
                setStatus('synced')
              }
            }
            if (t === 'push_result') {
              if (msg.ok && msg.project && typeof msg.revision === 'number') {
                revisionRef.current = msg.revision as number
                void mirrorLocalCache(
                  projectId,
                  JSON.stringify(msg.project),
                  msg.revision as number
                )
                setStatus('synced')
                setErrorMessage(null)
              }
              if (msg.conflict && msg.project && typeof msg.revision === 'number') {
                ignoreLocalUntilRef.current = Date.now() + 800
                applyRemoteProject(msg.project as SchemaProject)
                revisionRef.current = msg.revision as number
                setStatus('error')
                setErrorMessage('Conflict — loaded server version.')
              }
            }
            if (t === 'presence' && msg.user_id) {
              const uid = String(msg.user_id)
              if (localUserId && uid === localUserId) return
              const x = Number(msg.x) || 0
              const y = Number(msg.y) || 0
              const nodeId = String(msg.node_id ?? '')
              setRemotePresence((prev) => {
                const next = prev.filter((p) => p.userId !== uid)
                next.push({ userId: uid, x, y, nodeId, at: Date.now() })
                return next
              })
            }
          } catch {
            /* ignore */
          }
        }

        ws.onerror = () => {
          if (!cancelled) setStatus('error')
        }

        ws.onclose = () => {
          if (!cancelled) setStatus('idle')
        }
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setErrorMessage(e instanceof Error ? e.message : 'Sync bootstrap failed')
        }
      }
    }

    void bootstrap()

    const iv = setInterval(() => {
      setRemotePresence((prev) => prev.filter((p) => Date.now() - p.at < 8000))
    }, 2000)

    return () => {
      cancelled = true
      clearInterval(iv)
      closeWs()
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
    }
  }, [
    projectId,
    enabled,
    configured,
    applyRemoteProject,
    getProject,
    closeWs,
    localUserId,
  ])

  const reportPointer = useCallback(
    (x: number, y: number, nodeId: string) => {
      if (!enabled || !configured || !projectId) return
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      const lx = lastPresenceRef.current
      if (
        Math.abs(lx.x - x) < 4 &&
        Math.abs(lx.y - y) < 4 &&
        lx.nodeId === nodeId
      ) {
        return
      }
      lastPresenceRef.current = { x, y, nodeId }
      if (presenceThrottleRef.current) return
      presenceThrottleRef.current = setTimeout(() => {
        presenceThrottleRef.current = null
        try {
          wsRef.current?.send(
            JSON.stringify({
              type: 'presence',
              x,
              y,
              node_id: nodeId,
            })
          )
        } catch {
          /* ignore */
        }
      }, 80)
    },
    [enabled, configured, projectId]
  )

  const effectiveStatus: SchemaSyncStatus =
    !enabled || !configured || !projectId ? 'disabled' : status

  const copyShareLink = useCallback(
    async (permission: 'viewer' | 'editor') => {
      if (!projectId || !enabled || !configured) return null
      const token = await runtimeAuthGetToken()
      if (!token) return null
      const { token: shareToken } = await schemaSyncCreateShareLink(
        token,
        projectId,
        permission
      )
      const origin =
        typeof window !== 'undefined' ? window.location.origin : ''
      const webUrl = `${origin}/schema-projects/share?t=${encodeURIComponent(shareToken)}`
      const appUrl = `pgstudio://schema/share?token=${encodeURIComponent(shareToken)}`
      return { webUrl, appUrl, shareToken }
    },
    [projectId, enabled, configured]
  )

  return {
    status: effectiveStatus,
    errorMessage,
    configured,
    schedulePush,
    flushPush: flushOnePush,
    reportPointer,
    remotePresence,
    copyShareLink,
    clearError: () => setErrorMessage(null),
  }
}
