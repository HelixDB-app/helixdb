'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronUp,
  Code2,
  Database,
  History,
  ImagePlus,
  LayoutTemplate,
  Layers,
  MoreHorizontal,
  Plus,
  Rocket,
  Share2,
  Sparkles,
  Trash2,
  Files,
  User,
  X,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { useSchemaStore } from '@/lib/schema-store'
import {
  aiPayloadToSchemaTables,
  parseAiSchemaJsonBlock,
} from '@/lib/ai-schema-from-json'
import {
  DEFAULT_GROQ_MODEL_ID,
  getGroqModelById,
  pickGroqModelForAttachments,
  providerForSchemaAiModel,
} from '@/lib/groq-models'
import {
  prepareSchemaDesignerImageFile,
  SCHEMA_DESIGNER_IMAGE_ONLY_PROMPT,
  SCHEMA_DESIGNER_MAX_IMAGES_PER_SEND,
  type PreparedSchemaDesignerImage,
} from '@/lib/schema-designer-image'
import { useSchemaAiStream } from '@/lib/use-schema-ai-stream'
import { GroqModelPicker } from '@/components/groq-model-picker'
import { SchemaEditTableDialog } from '@/components/schema-edit-table-dialog'
import { ExportMenu } from '@/components/export-menu'
import { KeyboardHelp } from '@/components/keyboard-help'
import { ThemeToggle } from '@/components/theme-toggle'
import { MonacoSqlEditor } from '@/components/monaco-sql-editor'
import { generateSQL } from '@/lib/sql-export'
import {
  buildNewProject,
  parseSchemaSQL,
  projectToStore,
  storeToProject,
} from '@/lib/schema-designer-utils'
import {
  cacheProjectsToLocal,
  deleteLocalProject,
  loadLocalProject,
  saveLocalProject,
  takePendingProject,
} from '@/lib/schema-designer-storage'
import {
  schemaDesignerDeleteProject,
  schemaDesignerGetProject,
  schemaDesignerGroqHasApiKey,
  schemaDesignerSaveProject,
} from '@/lib/tauri'
import { isTauri } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import type {
  SchemaDesignerMessage,
  SchemaDesignerMessageAttachment,
  SchemaProject,
  SchemaSnapshot,
} from '@/lib/schema-designer-types'
import { schemaPerfHints } from '@/lib/schema-perf-hints'
import { isSchemaSyncConfigured } from '@/lib/schema-sync-config'
import { useSchemaSync } from '@/lib/use-schema-sync'
import { useAuthStore } from '@/stores/auth-store'
import { SchemaCloudSyncChip } from '@/components/schema-flow-canvas-toolbar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

type AgentLogPick =
  | { kind: 'live' }
  | { kind: 'snapshot'; snap: SchemaSnapshot }
  | { kind: 'message'; message: SchemaDesignerMessage }

const SCHEMA_QUICK_PROMPTS = [
  'Add auth tables',
  'Add audit logging',
  'Optimize for read-heavy workload',
] as const

type ComposerPendingImage = PreparedSchemaDesignerImage & { id: string }

function attachmentDataUrl(att: SchemaDesignerMessageAttachment): string {
  return `data:${att.mime_type};base64,${att.data_base64}`
}

function splitMarkdownSections(md: string): { title: string; body: string }[] {
  const t = md.trim()
  if (!t) return []
  if (!/^## /m.test(t)) {
    return [{ title: 'Notes', body: t }]
  }
  const chunks = t.split(/^## /m).filter(Boolean)
  return chunks.map((chunk) => {
    const lines = chunk.split('\n')
    const title = lines[0]?.trim() ?? 'Section'
    const body = lines.slice(1).join('\n').trim()
    return { title, body }
  })
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatShortTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Single-line preview for list rows (no raw markdown clutter). */
function previewPlainText(raw: string, maxLen: number): string {
  const flat = raw.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxLen) return flat
  return `${flat.slice(0, maxLen - 1)}…`
}

function firstHeadingOrLine(raw: string, maxLen: number): string {
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/^#{1,6}\s+(.+)$/)
    const cleaned = (m ? m[1] : t).replace(/\*\*|__/g, '').trim()
    if (!cleaned) continue
    return cleaned.length > maxLen
      ? `${cleaned.slice(0, maxLen - 1)}…`
      : cleaned
  }
  return previewPlainText(raw, maxLen)
}

export function SchemaDesigner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const {
    tables,
    relationships,
    functions,
    triggers,
    canvasItems,
    code,
    projectName,
    projectDescription,
    projectAppType,
    projectUpdatedAt,
    designerMessages,
    aiPanelMarkdown,
    thumbnailColor,
    lastModelId,
    lastGenerationOptionsJson,
    canvasStateJson,
    versionHistory,
    hydrateProject,
    setProjectMeta,
    setTables,
    setRelationships,
    setFunctions,
    setTriggers,
    setCode,
    appendDesignerMessage,
    setAiPanelMarkdown,
    setLastModelId,
  } = useSchemaStore()

  const { streaming: aiBusy, buffer: aiLiveBuffer, startStream } =
    useSchemaAiStream()
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const [agentLogExpanded, setAgentLogExpanded] = useState(false)
  const [agentLogPick, setAgentLogPick] = useState<AgentLogPick | null>(null)
  const [promptTemplatesOpen, setPromptTemplatesOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<
    ComposerPendingImage[]
  >([])
  const [composerDragging, setComposerDragging] = useState(false)
  const [imageLightboxSrc, setImageLightboxSrc] = useState<string | null>(null)
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false)
  const [versionPick, setVersionPick] = useState<string>('current')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [editorValue, setEditorValue] = useState(code)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const hydratingRef = useRef(false)
  const applyingParsedRef = useRef(false)
  const lastUpdateSourceRef = useRef<'editor' | 'tables' | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatComposerRef = useRef<HTMLTextAreaElement | null>(null)
  const imageFileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (parseTimerRef.current) clearTimeout(parseTimerRef.current)
    }
  }, [])

  const applyProject = useCallback(
    (project: ReturnType<typeof projectToStore>) => {
      hydratingRef.current = true
      hydrateProject(project)
      setEditorValue(project.code)
      setParseError(null)
      requestAnimationFrame(() => {
        hydratingRef.current = false
      })
    },
    [hydrateProject]
  )

  const { isAuthenticated, user } = useAuthStore()

  const getProject = useCallback((): SchemaProject => {
    const s = useSchemaStore.getState()
    const now = s.projectUpdatedAt ?? new Date().toISOString()
    return storeToProject(
      {
        projectId: s.projectId,
        projectName: s.projectName,
        projectDescription: s.projectDescription,
        projectAppType: s.projectAppType,
        projectCreatedAt: s.projectCreatedAt,
        projectUpdatedAt: s.projectUpdatedAt,
        tables: s.tables,
        relationships: s.relationships,
        functions: s.functions,
        triggers: s.triggers,
        canvasItems: s.canvasItems,
        code: s.code,
        designerMessages: s.designerMessages,
        aiPanelMarkdown: s.aiPanelMarkdown,
        thumbnailColor: s.thumbnailColor,
        lastModelId: s.lastModelId,
        lastGenerationOptionsJson: s.lastGenerationOptionsJson,
        canvasStateJson: s.canvasStateJson,
        versionHistory: s.versionHistory,
      },
      now
    )
  }, [])

  const applyRemoteProject = useCallback(
    (project: SchemaProject) => {
      applyProject(projectToStore(project))
      saveLocalProject(project)
      if (isTauri()) {
        void schemaDesignerSaveProject(project)
      }
    },
    [applyProject]
  )

  const syncEnabled =
    isAuthenticated && isSchemaSyncConfigured() && !loading && !!projectId

  const cloudSync = useSchemaSync({
    projectId,
    enabled: syncEnabled,
    localUserId: user?.id ?? null,
    getProject,
    applyRemoteProject,
  })

  const prevSavingRef = useRef(false)
  const schedulePushRef = useRef(cloudSync.schedulePush)
  useEffect(() => {
    schedulePushRef.current = cloudSync.schedulePush
  }, [cloudSync.schedulePush])
  useEffect(() => {
    if (prevSavingRef.current && !saving && syncEnabled && !loading) {
      schedulePushRef.current()
    }
    prevSavingRef.current = saving
  }, [saving, syncEnabled, loading])

  useEffect(() => {
    let cancelled = false
    const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), ms)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      setVersionPick('current')
      let bootstrapped = false
      const pending = takePendingProject(projectId)
      if (pending && !cancelled) {
        applyProject(projectToStore(pending))
        saveLocalProject(pending)
        setLoading(false)
        bootstrapped = true
      }
      const local = pending ?? loadLocalProject(projectId)
      if (!bootstrapped && local && !cancelled) {
        applyProject(projectToStore(local))
        setLoading(false)
        bootstrapped = true
      }
      if (!bootstrapped && !local && !cancelled) {
        const fresh = buildNewProject({ id: projectId })
        applyProject(projectToStore(fresh))
        saveLocalProject(fresh)
        setLoading(false)
        bootstrapped = true
      }

      if (isTauri()) {
        try {
          const remote = await withTimeout(schemaDesignerGetProject(projectId), 8000)
          if (cancelled) return
          if (remote) {
            if (!local) {
              applyProject(projectToStore(remote))
            } else {
              const localTime = new Date(local.updated_at).getTime()
              const remoteTime = new Date(remote.updated_at).getTime()
              if (remoteTime > localTime) {
                applyProject(projectToStore(remote))
              }
            }
            saveLocalProject(remote)
          } else if (!local) {
            const fresh = buildNewProject({ id: projectId })
            // Project already shown locally; only ensure desktop storage eventually catches up.
            void schemaDesignerSaveProject(fresh)
          }
        } catch {
          if (!cancelled && local) {
            setLoadError(
              'Could not refresh this project from the app. Using your saved local copy.'
            )
          }
          if (!local && !cancelled) {
            setLoadError(
              'Project opened from local cache. Cloud refresh timed out, but your schema is ready.'
            )
          }
        }
      }
      if (!cancelled && !bootstrapped) {
        setLoading(false)
      }
    }
    load()
    const hardStop = setTimeout(() => {
      if (!cancelled) {
        setLoading(false)
      }
    }, 3000)
    return () => {
      cancelled = true
      clearTimeout(hardStop)
    }
  }, [applyProject, projectId])

  const scheduleSave = useCallback(() => {
    if (hydratingRef.current) return
    setDirty(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true)
      const now = new Date().toISOString()
      const current = useSchemaStore.getState()
      current.setProjectMeta({
        projectUpdatedAt: now,
        projectCreatedAt: current.projectCreatedAt ?? now,
      })
      const project = storeToProject(
        {
          projectId: current.projectId,
          projectName: current.projectName,
          projectDescription: current.projectDescription,
          projectAppType: current.projectAppType,
          projectCreatedAt: current.projectCreatedAt,
          projectUpdatedAt: current.projectUpdatedAt,
          tables: current.tables,
          relationships: current.relationships,
          functions: current.functions,
          triggers: current.triggers,
          canvasItems: current.canvasItems,
          code: current.code,
          designerMessages: current.designerMessages,
          aiPanelMarkdown: current.aiPanelMarkdown,
          thumbnailColor: current.thumbnailColor,
          lastModelId: current.lastModelId,
          lastGenerationOptionsJson: current.lastGenerationOptionsJson,
          canvasStateJson: current.canvasStateJson,
          versionHistory: current.versionHistory,
        },
        now
      )
      saveLocalProject(project)
      if (isTauri()) {
        try {
          await schemaDesignerSaveProject(project)
        } catch {
          // ignore remote save errors; local is still updated
        }
      }
      setSaving(false)
      setDirty(false)
    }, 600)
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect -- debounced persist + SQL sync */
  useEffect(() => {
    if (loading || hydratingRef.current) return
    scheduleSave()
  }, [
    tables,
    relationships,
    code,
    projectName,
    projectDescription,
    projectAppType,
    functions,
    triggers,
    canvasItems,
    loading,
    scheduleSave,
    designerMessages,
    aiPanelMarkdown,
    thumbnailColor,
    lastModelId,
    lastGenerationOptionsJson,
    canvasStateJson,
    versionHistory,
  ])

  useEffect(() => {
    if (loading || hydratingRef.current || applyingParsedRef.current) return
    if (lastUpdateSourceRef.current === 'editor') {
      lastUpdateSourceRef.current = null
      return
    }
    const nextCode = generateSQL(tables, relationships, functions, triggers)
    if (nextCode !== code) {
      lastUpdateSourceRef.current = 'tables'
      setCode(nextCode)
      setEditorValue(nextCode)
      setParseError(null)
    }
  }, [tables, relationships, functions, triggers, code, loading, setCode])

  useEffect(() => {
    if (loading || applyingParsedRef.current) return
    if (code !== editorValue) setEditorValue(code)
  }, [code, editorValue, loading])
  /* eslint-enable react-hooks/set-state-in-effect */

  const scheduleParse = useCallback((value: string) => {
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current)
    parseTimerRef.current = setTimeout(() => {
      if (!value.trim()) {
        setParseError(null)
        return
      }
      const existing = useSchemaStore.getState()
      const parsed = parseSchemaSQL(value, {
        tables: existing.tables,
        relationships: existing.relationships,
        functions: existing.functions,
        triggers: existing.triggers,
      })
      if (!parsed) {
        setParseError('Unable to parse SQL. Check syntax for CREATE TABLE.')
        return
      }
      applyingParsedRef.current = true
      setTables(parsed.tables)
      setRelationships(parsed.relationships)
      setFunctions(parsed.functions)
      setTriggers(parsed.triggers)
      setParseError(null)
      requestAnimationFrame(() => {
        applyingParsedRef.current = false
      })
    }, 350)
  }, [setFunctions, setRelationships, setTables, setTriggers])

  const handleEditorChange = useCallback(
    (value: string) => {
      lastUpdateSourceRef.current = 'editor'
      setEditorValue(value)
      setCode(value)
      scheduleParse(value)
    },
    [scheduleParse, setCode]
  )

  const handleDuplicate = useCallback(async () => {
    const now = new Date().toISOString()
    const current = useSchemaStore.getState()
    const newId = `project-${Date.now()}`
    const project = storeToProject(
      {
        projectId: newId,
        projectName: `${current.projectName || 'Untitled'} Copy`,
        projectDescription: current.projectDescription,
        projectAppType: current.projectAppType,
        projectCreatedAt: now,
        projectUpdatedAt: now,
        tables: current.tables,
        relationships: current.relationships,
        functions: current.functions,
        triggers: current.triggers,
        canvasItems: current.canvasItems,
        code: current.code,
        designerMessages: current.designerMessages,
        aiPanelMarkdown: current.aiPanelMarkdown,
        thumbnailColor: current.thumbnailColor,
        lastModelId: current.lastModelId,
        lastGenerationOptionsJson: current.lastGenerationOptionsJson,
        canvasStateJson: current.canvasStateJson,
        versionHistory: current.versionHistory,
      },
      now
    )
    saveLocalProject(project)
    if (isTauri()) {
      try {
        const list = await schemaDesignerSaveProject(project)
        cacheProjectsToLocal(list)
      } catch {
        // ignore
      }
    }
    router.push(`/schema-projects/designer?id=${newId}`)
  }, [router])

  const handleDelete = useCallback(async () => {
    deleteLocalProject(projectId)
    if (isTauri()) {
      try {
        const list = await schemaDesignerDeleteProject(projectId)
        cacheProjectsToLocal(list)
      } catch {
        // ignore
      }
    }
    router.push('/schema-projects')
  }, [projectId, router])

  const narrativeSections = useMemo(
    () => splitMarkdownSections(aiPanelMarkdown),
    [aiPanelMarkdown]
  )

  const perfHints = useMemo(
    () => schemaPerfHints(tables, relationships),
    [tables, relationships]
  )

  const smarts = useMemo(() => {
    const s: string[] = []
    if (tables.every((t) => !t.name.toLowerCase().includes('session'))) {
      s.push('Consider sessions / refresh token storage if you add authentication.')
    }
    if (!tables.some((t) => t.name.toLowerCase().includes('audit'))) {
      s.push('Optional dedicated audit_log table for sensitive mutations.')
    }
    return s.slice(0, 4)
  }, [tables])

  const agentLogRows = useMemo(() => {
    type Row =
      | { key: string; kind: 'live' }
      | { key: string; kind: 'snapshot'; snap: SchemaSnapshot }
      | { key: string; kind: 'message'; message: SchemaDesignerMessage }
    const rows: Row[] = []
    const linkedAssistantIds = new Set(
      versionHistory
        .map((s) => s.conversation_turn_id)
        .filter((id): id is string => Boolean(id))
    )

    if (aiBusy || aiPanelMarkdown.trim().length > 0) {
      rows.push({ key: 'live', kind: 'live' })
    }

    const snaps = [...versionHistory].sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    for (const snap of snaps) {
      rows.push({ key: `snap-${snap.id}`, kind: 'snapshot', snap })
    }

    const recent = [...designerMessages].slice(-24).reverse()
    for (const m of recent) {
      if (m.role === 'system') continue
      if (m.role === 'assistant' && linkedAssistantIds.has(m.id)) continue
      rows.push({ key: m.id, kind: 'message', message: m })
    }

    return rows.slice(0, 36)
  }, [aiBusy, aiPanelMarkdown, versionHistory, designerMessages])

  const applyVersionSnapshot = useCallback(
    (snap: SchemaSnapshot) => {
      const st = useSchemaStore.getState()
      const base = storeToProject(
        {
          projectId: st.projectId,
          projectName: st.projectName,
          projectDescription: st.projectDescription,
          projectAppType: st.projectAppType,
          projectCreatedAt: st.projectCreatedAt,
          projectUpdatedAt: st.projectUpdatedAt,
          tables: st.tables,
          relationships: st.relationships,
          functions: st.functions,
          triggers: st.triggers,
          canvasItems: st.canvasItems,
          code: st.code,
          designerMessages: st.designerMessages,
          aiPanelMarkdown: st.aiPanelMarkdown,
          thumbnailColor: st.thumbnailColor,
          lastModelId: st.lastModelId,
          lastGenerationOptionsJson: st.lastGenerationOptionsJson,
          canvasStateJson: st.canvasStateJson,
          versionHistory: st.versionHistory,
        },
        new Date().toISOString()
      )
      const next: SchemaProject = {
        ...base,
        tables: structuredClone(snap.tables),
        updated_at: new Date().toISOString(),
      }
      hydrateProject(projectToStore(next))
      setVersionPick(snap.id)
      toast.info(`Restored: ${snap.label}`)
    },
    [hydrateProject]
  )

  const handleRefine = useCallback(
    async (text: string, prepared?: PreparedSchemaDesignerImage[]) => {
      const trimmed = text.trim()
      const hasImages = Boolean(prepared?.length)
      if (!trimmed && !hasImages) return
      if (!isTauri()) {
        toast.error('AI runs in the desktop app.')
        return
      }
      const st0 = useSchemaStore.getState()
      const baseModel = st0.lastModelId || DEFAULT_GROQ_MODEL_ID
      const streamModel = pickGroqModelForAttachments(baseModel, hasImages)
      try {
        const provider = providerForSchemaAiModel(streamModel)
        if (provider !== 'worker') {
          const ok = await schemaDesignerGroqHasApiKey()
          if (!ok) {
            toast.error('Add API credentials from the Schema home screen.')
            return
          }
        }
      } catch {
        toast.error('Could not verify API credentials.')
        return
      }
      if (streamModel !== baseModel) {
        setLastModelId(streamModel)
        toast.message('Vision model', {
          description: `${getGroqModelById(streamModel)?.label ?? streamModel} is used for image input.`,
        })
      }

      const effectiveText = trimmed || SCHEMA_DESIGNER_IMAGE_ONLY_PROMPT
      const storedAttachments = prepared?.map(({ mime_type, data_base64 }) => ({
        mime_type,
        data_base64,
      }))

      appendDesignerMessage({
        id: `msg-${Date.now()}-u`,
        role: 'user',
        content: effectiveText,
        created_at: new Date().toISOString(),
        ...(storedAttachments?.length ? { attachments: storedAttachments } : {}),
      })
      const afterUser = useSchemaStore.getState()
      const msgs = afterUser.designerMessages.map((m) => {
        const role = m.role === 'assistant' ? 'assistant' : 'user'
        const row: {
          role: string
          content: string
          attachments?: Array<{ mime_type: string; data_base64: string }>
        } = { role, content: m.content }
        if (
          m.role !== 'assistant' &&
          m.attachments &&
          m.attachments.length > 0
        ) {
          row.attachments = m.attachments.map((a) => ({
            mime_type: a.mime_type,
            data_base64: a.data_base64,
          }))
        }
        return row
      })
      await startStream(
        {
          projectId,
          messages: msgs,
          model: streamModel,
          temperature: 0.35,
          maxTokens: 8192,
          options: { databaseTarget: 'postgresql' },
        },
        {
          onDone: (err, full) => {
            if (err && err !== 'Cancelled') {
              toast.error(err)
              return
            }
            const payload = parseAiSchemaJsonBlock(full)
            const restMarkdown = full.replace(/```json[\s\S]*?```\s*/, '').trim()
            const assistantMsg = {
              id: `msg-${Date.now()}-a`,
              role: 'assistant' as const,
              content: restMarkdown.slice(0, 20000),
              created_at: new Date().toISOString(),
              model: streamModel,
            }
            appendDesignerMessage(assistantMsg)
            setAiPanelMarkdown(restMarkdown)
            if (payload) {
              const schemaTables = aiPayloadToSchemaTables(payload)
              const st2 = useSchemaStore.getState()
              const blob = storeToProject(
                {
                  projectId: st2.projectId,
                  projectName: st2.projectName,
                  projectDescription: st2.projectDescription,
                  projectAppType: st2.projectAppType,
                  projectCreatedAt: st2.projectCreatedAt,
                  projectUpdatedAt: st2.projectUpdatedAt,
                  tables: st2.tables,
                  relationships: st2.relationships,
                  functions: st2.functions,
                  triggers: st2.triggers,
                  canvasItems: st2.canvasItems,
                  code: st2.code,
                  designerMessages: st2.designerMessages,
                  aiPanelMarkdown: restMarkdown,
                  thumbnailColor: st2.thumbnailColor,
                  lastModelId: st2.lastModelId,
                  lastGenerationOptionsJson: st2.lastGenerationOptionsJson,
                  canvasStateJson: st2.canvasStateJson,
                  versionHistory: [
                    ...st2.versionHistory,
                    {
                      id: `ver-${Date.now()}`,
                      label: 'AI refine',
                      timestamp: new Date().toISOString(),
                      tables: structuredClone(schemaTables),
                      conversation_turn_id: assistantMsg.id,
                    },
                  ],
                },
                new Date().toISOString()
              )
              const nextBlob: SchemaProject = {
                ...blob,
                tables: schemaTables,
              }
              hydrateProject(projectToStore(nextBlob))
            }
            toast.success('Updated')
          },
        }
      )
    },
    [
      projectId,
      appendDesignerMessage,
      startStream,
      setAiPanelMarkdown,
      hydrateProject,
      setLastModelId,
    ]
  )

  const addImagesFromFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    for (const file of list) {
      let atCap = false
      setPendingAttachments((prev) => {
        if (prev.length >= SCHEMA_DESIGNER_MAX_IMAGES_PER_SEND) {
          atCap = true
        }
        return prev
      })
      if (atCap) {
        toast.error(
          `At most ${SCHEMA_DESIGNER_MAX_IMAGES_PER_SEND} images per message.`
        )
        break
      }
      if (file.size > 25 * 1024 * 1024) {
        toast.error('Image too large before processing (max 25MB).')
        continue
      }
      try {
        const p = await prepareSchemaDesignerImageFile(file)
        setPendingAttachments((prev) => {
          if (prev.length >= SCHEMA_DESIGNER_MAX_IMAGES_PER_SEND) return prev
          return [...prev, { ...p, id: crypto.randomUUID() }]
        })
      } catch {
        toast.error('Could not process image.')
      }
    }
  }, [])

  const submitComposer = useCallback(async () => {
    if (aiBusy) return
    const t = chatInput
    const imgs = pendingAttachments
    if (!t.trim() && imgs.length === 0) return
    const payload: PreparedSchemaDesignerImage[] | undefined =
      imgs.length > 0
        ? imgs.map(({ id: _id, ...rest }) => rest)
        : undefined
    setChatInput('')
    setPendingAttachments([])
    await handleRefine(t, payload)
  }, [aiBusy, chatInput, pendingAttachments, handleRefine])

  const statusLabel = saving
    ? 'Saving...'
    : dirty
      ? 'Unsaved changes'
      : 'All changes saved'

  const statusVariant = saving ? 'secondary' : dirty ? 'outline' : 'secondary'

  useEffect(() => {
    if (!agentLogPick) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAgentLogPick(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentLogPick])

  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-background">
      <header className="relative z-[70] flex shrink-0 items-center justify-between border-b border-border/60 bg-muted/50 px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/schema-projects">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <Database className="h-5 w-5 text-primary" />
            <Input
              value={projectName}
              onChange={(e) =>
                setProjectMeta({ projectName: e.target.value })
              }
              className="h-8 w-[220px] bg-background"
              placeholder="Project name"
            />
          </div>
          <Badge variant={statusVariant} className="hidden sm:inline-flex">
            {statusLabel}
          </Badge>
          <span className="text-xs text-muted-foreground hidden lg:inline-flex">
            Updated {formatTimestamp(projectUpdatedAt)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => setSqlDialogOpen(true)}
          >
            <Code2 className="h-3.5 w-3.5" />
            SQL
          </Button>
          <ThemeToggle />
          <ExportMenu />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleDuplicate}>
                <Files className="h-4 w-4 mr-2" />
                Duplicate project
              </DropdownMenuItem>
              {syncEnabled ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      void (async () => {
                        const r = await cloudSync.copyShareLink('viewer')
                        if (r) {
                          await navigator.clipboard.writeText(r.webUrl)
                          toast.success('Web share link copied (viewer)')
                        } else {
                          toast.error('Could not create share link')
                        }
                      })()
                    }}
                  >
                    <Share2 className="h-4 w-4 mr-2" />
                    Copy web link (viewer)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      void (async () => {
                        const r = await cloudSync.copyShareLink('editor')
                        if (r) {
                          await navigator.clipboard.writeText(r.webUrl)
                          toast.success('Web share link copied (editor)')
                        } else {
                          toast.error('Could not create share link')
                        }
                      })()
                    }}
                  >
                    <Share2 className="h-4 w-4 mr-2" />
                    Copy web link (editor)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      void (async () => {
                        const r = await cloudSync.copyShareLink('viewer')
                        if (r) {
                          await navigator.clipboard.writeText(r.appUrl)
                          toast.success('Open-in-app link copied')
                        } else {
                          toast.error('Could not create share link')
                        }
                      })()
                    }}
                  >
                    <Rocket className="h-4 w-4 mr-2" />
                    Copy open-in-app link
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <KeyboardHelp />
        </div>
      </header>

      <div className="relative flex-1 min-h-0">
        {loading ? (
          <div className="absolute inset-0 overflow-auto p-6 sm:p-8">
            <div className="mx-auto max-w-5xl space-y-5">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Database className="h-5 w-5 shrink-0 text-primary" />
                <span>Loading schema canvas…</span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <div
                    key={i}
                    className="space-y-3 rounded-xl border border-border/40 bg-card/25 p-4"
                  >
                    <Skeleton className="h-8 w-[72%] rounded-md" />
                    <Skeleton className="h-3.5 w-full rounded-md" />
                    <Skeleton className="h-3.5 w-[88%] rounded-md" />
                    <Skeleton className="h-3.5 w-[55%] rounded-md" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0">
            {loadError ? (
              <Alert className="absolute left-3 right-3 top-3 z-[45] max-w-2xl border-amber-500/35 bg-amber-500/[0.08] shadow-md backdrop-blur-sm">
                <AlertTitle className="text-sm">Offline copy</AlertTitle>
                <AlertDescription className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                  <span>{loadError}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-fit shrink-0"
                    onClick={() => setLoadError(null)}
                  >
                    Dismiss
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <FlowCanvas
              cloudSyncSlot={
                syncEnabled ? (
                  <SchemaCloudSyncChip
                    status={cloudSync.status}
                    title={cloudSync.errorMessage ?? undefined}
                    onRetry={() => {
                      cloudSync.clearError()
                      void cloudSync.flushPush()
                    }}
                  />
                ) : null
              }
              remotePresence={cloudSync.remotePresence.map((p) => ({
                userId: p.userId,
                x: p.x,
                y: p.y,
                nodeId: p.nodeId,
              }))}
              onPanePointerFlowPosition={
                syncEnabled
                  ? (pos) => cloudSync.reportPointer(pos.x, pos.y, '')
                  : undefined
              }
            />

            <div className="pointer-events-none absolute bottom-5 left-4 z-[55] flex max-w-[min(340px,calc(100vw-2rem))] flex-col items-stretch gap-2">
              {agentLogExpanded ? (
                <div className="pointer-events-auto overflow-hidden rounded-2xl border border-border/55 bg-card/94 shadow-[0_12px_40px_-6px_rgba(0,0,0,0.35)] backdrop-blur-xl dark:bg-card/88">
                  <div className="border-b border-border/40 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Activity
                    </p>
                    <p className="text-[10px] text-muted-foreground/90">
                      Snapshots and messages — open for full detail
                    </p>
                  </div>
                  <ScrollArea className="max-h-[min(38vh,320px)]">
                    <div className="space-y-1 p-2">
                      {agentLogRows.length === 0 ? (
                        <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                          No activity yet. Send a prompt below to generate schema
                          and narrative.
                        </p>
                      ) : (
                        agentLogRows.map((row, i) => {
                          const isFirstLive =
                            row.kind === 'live' && i === 0 && aiBusy
                          const badge =
                            row.kind === 'live'
                              ? aiBusy
                                ? { label: 'Live', variant: 'default' as const }
                                : { label: 'Narrative', variant: 'secondary' as const }
                              : row.kind === 'snapshot'
                                ? {
                                    label: 'Version',
                                    variant: 'outline' as const,
                                  }
                                : row.message.role === 'user'
                                  ? { label: 'You', variant: 'outline' as const }
                                  : {
                                      label: 'Assistant',
                                      variant: 'secondary' as const,
                                    }
                          const title =
                            row.kind === 'live'
                              ? aiBusy
                                ? 'Model is responding…'
                                : 'Current schema narrative'
                              : row.kind === 'snapshot'
                                ? row.snap.label
                                : row.message.role === 'user'
                                  ? previewPlainText(row.message.content, 64)
                                  : firstHeadingOrLine(row.message.content, 72)
                          const sub =
                            row.kind === 'live'
                              ? aiBusy
                                ? 'Streaming to canvas'
                                : `${narrativeSections.length} doc sections`
                              : row.kind === 'snapshot'
                                ? `${row.snap.tables.length} tables · ${formatShortTime(row.snap.timestamp)}`
                                : formatShortTime(row.message.created_at)
                          const Icon =
                            row.kind === 'live'
                              ? Sparkles
                              : row.kind === 'snapshot'
                                ? Layers
                                : row.message.role === 'user'
                                  ? User
                                  : Bot
                          return (
                            <button
                              key={row.key}
                              type="button"
                              onClick={() =>
                                setAgentLogPick(
                                  row.kind === 'live'
                                    ? { kind: 'live' }
                                    : row.kind === 'snapshot'
                                      ? { kind: 'snapshot', snap: row.snap }
                                      : {
                                          kind: 'message',
                                          message: row.message,
                                        }
                                )
                              }
                              className={cn(
                                'flex w-full items-start gap-2.5 rounded-xl border border-transparent px-2.5 py-2.5 text-left transition hover:border-border/45 hover:bg-muted/40',
                                isFirstLive &&
                                  'border-primary/25 bg-primary/[0.07] hover:bg-primary/[0.1]'
                              )}
                            >
                              <span
                                className={cn(
                                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground',
                                  row.kind === 'live' &&
                                    'bg-primary/10 text-primary',
                                  row.kind === 'snapshot' &&
                                    'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                )}
                              >
                                <Icon className="h-4 w-4" strokeWidth={2} />
                              </span>
                              <span className="min-w-0 flex-1 space-y-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <Badge
                                    variant={badge.variant}
                                    className="h-5 rounded-md px-1.5 text-[10px] font-medium"
                                  >
                                    {badge.label}
                                  </Badge>
                                  {row.kind === 'message' &&
                                  row.message.role === 'assistant' &&
                                  row.message.model ? (
                                    <span className="truncate text-[10px] text-muted-foreground">
                                      {row.message.model.includes('/')
                                        ? row.message.model.split('/').pop()
                                        : row.message.model}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="block text-xs font-medium leading-snug text-foreground">
                                  {title}
                                </span>
                                <span className="block text-[11px] text-muted-foreground">
                                  {sub}
                                </span>
                              </span>
                            </button>
                          )
                        })
                      )}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setAgentLogExpanded((v) => !v)}
                className={cn(
                  'pointer-events-auto flex h-10 items-center gap-2 self-start rounded-full border border-border/60 bg-card/92 px-3.5 shadow-lg backdrop-blur-xl hover:bg-card dark:bg-card/85',
                  aiBusy && 'ring-2 ring-primary/25'
                )}
              >
                <Rocket
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  strokeWidth={2}
                />
                <span className="text-xs font-semibold tracking-tight">
                  Agent log
                </span>
                <ChevronUp
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                    !agentLogExpanded && 'rotate-180'
                  )}
                />
              </button>
            </div>

            <Sheet
              open={agentLogPick !== null}
              onOpenChange={(o) => {
                if (!o) setAgentLogPick(null)
              }}
            >
              <SheetContent
                side="right"
                className="gap-0 border-l border-border/50 p-0 sm:max-w-xl"
              >
                {agentLogPick?.kind === 'live' ? (
                  <>
                    <SheetHeader>
                      <div className="flex items-center gap-2">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                          <Sparkles className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <SheetTitle>Schema narrative</SheetTitle>
                          <SheetDescription>
                            Overview, AI notes, and canvas context
                          </SheetDescription>
                        </div>
                      </div>
                    </SheetHeader>
                    <SheetBody>
                      <ScrollArea className="h-[calc(100vh-8rem)]">
                        <div className="space-y-4 p-5 pb-10">
                          {versionHistory.length > 0 ? (
                            <div className="space-y-2 rounded-xl border border-border/40 bg-muted/[0.08] p-3">
                              <Label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Version history
                              </Label>
                              <Select
                                value={versionPick}
                                onValueChange={(v) => {
                                  setVersionPick(v)
                                  if (v === 'current') return
                                  const snap = versionHistory.find((x) => x.id === v)
                                  if (!snap) return
                                  applyVersionSnapshot(snap)
                                }}
                              >
                                <SelectTrigger className="h-9 text-xs">
                                  <SelectValue placeholder="Snapshot" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="current">
                                    Current (live)
                                  </SelectItem>
                                  {versionHistory.map((snap) => (
                                    <SelectItem key={snap.id} value={snap.id}>
                                      {snap.label} ·{' '}
                                      {formatTimestamp(snap.timestamp)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : null}
                          {aiBusy ? (
                            <div className="rounded-2xl border border-primary/20 bg-card/80 p-4 font-mono text-[12px] leading-relaxed text-foreground/90 shadow-sm ring-1 ring-primary/10 whitespace-pre-wrap">
                              {aiLiveBuffer}
                              <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />
                            </div>
                          ) : narrativeSections.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-border/60 bg-muted/15 px-4 py-10 text-center">
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                Overview, table notes, and performance tips from
                                the model will stream here after you refine.
                              </p>
                            </div>
                          ) : (
                            narrativeSections.map(
                              (sec: { title: string; body: string }) => (
                                <div
                                  key={sec.title}
                                  className="overflow-hidden rounded-2xl border border-border/50 bg-card/35 shadow-sm ring-1 ring-black/[0.03] dark:ring-white/[0.06]"
                                >
                                  <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-xs font-semibold tracking-tight hover:bg-muted/30"
                                    onClick={() =>
                                      setOpenSections((o) => ({
                                        ...o,
                                        [sec.title]: !o[sec.title],
                                      }))
                                    }
                                  >
                                    {sec.title}
                                    <ChevronDown
                                      className={cn(
                                        'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                                        openSections[sec.title] === false
                                          ? '-rotate-90'
                                          : ''
                                      )}
                                    />
                                  </button>
                                  {openSections[sec.title] !== false ? (
                                    <div className="border-t border-border/35 bg-muted/[0.1] px-4 py-3 text-[12px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
                                      {sec.body || '—'}
                                    </div>
                                  ) : null}
                                </div>
                              )
                            )
                          )}
                          {smarts.length > 0 ? (
                            <div className="rounded-2xl border border-dashed border-primary/30 bg-gradient-to-br from-primary/[0.06] to-transparent p-4">
                              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-primary">
                                Suggestions
                              </p>
                              <ul className="list-disc space-y-1 pl-4 text-[12px] text-muted-foreground">
                                {smarts.map((s: string) => (
                                  <li key={s}>{s}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {perfHints.length > 0 ? (
                            <div className="rounded-2xl border border-border/45 bg-muted/20 p-4 shadow-sm">
                              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Performance
                              </p>
                              <ul className="list-disc space-y-1 pl-4 text-[12px] text-muted-foreground">
                                {perfHints.map((s: string) => (
                                  <li key={s}>{s}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </ScrollArea>
                    </SheetBody>
                  </>
                ) : null}
                {agentLogPick?.kind === 'snapshot' ? (
                  <>
                    <SheetHeader>
                      <SheetTitle className="pr-8">
                        {agentLogPick.snap.label}
                      </SheetTitle>
                      <SheetDescription>
                        {formatTimestamp(agentLogPick.snap.timestamp)} ·{' '}
                        {agentLogPick.snap.tables.length} tables
                      </SheetDescription>
                    </SheetHeader>
                    <SheetBody>
                      <ScrollArea className="h-[calc(100vh-8rem)]">
                        <div className="space-y-4 p-5 pb-10">
                          <Button
                            type="button"
                            className="w-full rounded-xl"
                            onClick={() =>
                              applyVersionSnapshot(agentLogPick.snap)
                            }
                          >
                            Restore this version
                          </Button>
                          {agentLogPick.snap.conversation_turn_id ? (
                            <p className="text-[11px] text-muted-foreground">
                              Linked to conversation turn{' '}
                              <span className="font-mono text-[10px]">
                                {agentLogPick.snap.conversation_turn_id}
                              </span>
                            </p>
                          ) : null}
                          <div className="rounded-2xl border border-border/50 bg-muted/[0.08] p-3">
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Tables in snapshot
                            </p>
                            <ul className="max-h-[45vh] space-y-1 overflow-y-auto text-[12px] text-foreground/90">
                              {agentLogPick.snap.tables.map((t) => (
                                <li
                                  key={t.id}
                                  className="flex justify-between gap-2 border-b border-border/20 py-1.5 last:border-0"
                                >
                                  <span className="font-medium">{t.name}</span>
                                  <span className="shrink-0 tabular-nums text-muted-foreground">
                                    {t.columns?.length ?? 0} cols
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </ScrollArea>
                    </SheetBody>
                  </>
                ) : null}
                {agentLogPick?.kind === 'message' ? (
                  <>
                    <SheetHeader>
                      <SheetTitle className="pr-8">
                        {agentLogPick.message.role === 'user'
                          ? 'Your message'
                          : 'Assistant'}
                      </SheetTitle>
                      <SheetDescription className="tabular-nums">
                        {formatTimestamp(agentLogPick.message.created_at)}
                        {agentLogPick.message.model
                          ? ` · ${agentLogPick.message.model}`
                          : ''}
                      </SheetDescription>
                    </SheetHeader>
                    <SheetBody>
                      <ScrollArea className="h-[calc(100vh-8rem)]">
                        <div className="space-y-3 p-5 pb-10">
                          {agentLogPick.message.role === 'user' &&
                          agentLogPick.message.attachments &&
                          agentLogPick.message.attachments.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {agentLogPick.message.attachments.map((att, i) => (
                                <button
                                  key={`${i}-${att.mime_type}`}
                                  type="button"
                                  className="overflow-hidden rounded-xl ring-1 ring-border/50 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() =>
                                    setImageLightboxSrc(attachmentDataUrl(att))
                                  }
                                >
                                  <img
                                    src={attachmentDataUrl(att)}
                                    alt=""
                                    className="h-20 w-20 object-cover"
                                  />
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <div className="rounded-2xl border border-border/50 bg-card/40 p-4 shadow-inner">
                            <pre className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/95">
                              {agentLogPick.message.content}
                            </pre>
                          </div>
                        </div>
                      </ScrollArea>
                    </SheetBody>
                  </>
                ) : null}
              </SheetContent>
            </Sheet>

            <div className="pointer-events-auto absolute bottom-5 left-1/2 z-[50] w-[min(56rem,calc(100vw-1.25rem))] -translate-x-1/2">
              <input
                ref={imageFileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => {
                  const fl = e.target.files
                  if (fl?.length) void addImagesFromFiles(fl)
                  e.target.value = ''
                }}
              />
              <div
                className={cn(
                  'relative rounded-[1.75rem] border border-border/50 bg-card/90 shadow-[0_20px_64px_-12px_rgba(0,0,0,0.38)] backdrop-blur-xl dark:bg-card/78 dark:shadow-[0_24px_72px_-8px_rgba(0,0,0,0.55)]',
                  composerDragging &&
                    'ring-2 ring-primary/45 ring-offset-2 ring-offset-background'
                )}
                onDragEnter={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  dragDepthRef.current += 1
                  if (dragDepthRef.current === 1) setComposerDragging(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  dragDepthRef.current -= 1
                  if (dragDepthRef.current <= 0) {
                    dragDepthRef.current = 0
                    setComposerDragging(false)
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  dragDepthRef.current = 0
                  setComposerDragging(false)
                  void addImagesFromFiles(e.dataTransfer.files)
                }}
              >
                {composerDragging ? (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.75rem] bg-background/80 backdrop-blur-sm">
                    <p className="text-sm font-medium text-foreground">
                      Drop image to attach
                    </p>
                  </div>
                ) : null}
                <div className="overflow-hidden rounded-[1.2rem] border border-border/40 bg-background/50 dark:bg-background/30">
                  {pendingAttachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2 border-b border-border/35 px-3 py-2.5">
                      {pendingAttachments.map((img) => (
                        <div key={img.id} className="relative">
                          <button
                            type="button"
                            className="block overflow-hidden rounded-xl ring-1 ring-border/45 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => setImageLightboxSrc(img.data_url)}
                          >
                            <img
                              src={img.data_url}
                              alt=""
                              className="h-14 w-14 object-cover sm:h-16 sm:w-16"
                            />
                          </button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            className="absolute -right-1.5 -top-1.5 h-6 w-6 rounded-full border border-border/60 shadow-md"
                            aria-label="Remove image"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              setPendingAttachments((p) =>
                                p.filter((x) => x.id !== img.id)
                              )
                            }}
                          >
                            <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <Textarea
                    ref={chatComposerRef}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="What would you like to change or create?"
                    className="min-h-[56px] max-h-[200px] resize-none rounded-none border-0 bg-transparent px-4 pb-2 pt-3.5 text-sm shadow-none placeholder:text-muted-foreground/75 focus-visible:ring-0 focus-visible:ring-offset-0"
                    disabled={aiBusy}
                    rows={2}
                    onPaste={(e) => {
                      const items = e.clipboardData?.items
                      if (!items) return
                      for (const item of Array.from(items)) {
                        if (item.type.startsWith('image/')) {
                          e.preventDefault()
                          const file = item.getAsFile()
                          if (file) void addImagesFromFiles([file])
                        }
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void submitComposer()
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-2 border-t border-border/35 px-1 py-1.5">
                    <div className="flex min-w-0 items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                            aria-label="Focus prompt"
                            onClick={() => chatComposerRef.current?.focus()}
                          >
                            <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Focus the prompt
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                            aria-label="Attach image"
                            disabled={aiBusy}
                            onClick={() => imageFileInputRef.current?.click()}
                          >
                            <ImagePlus
                              className="h-[18px] w-[18px]"
                              strokeWidth={2}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Attach image (drop or paste)
                        </TooltipContent>
                      </Tooltip>
                      <Popover
                        open={promptTemplatesOpen}
                        onOpenChange={setPromptTemplatesOpen}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                                aria-label="Prompt templates"
                              >
                                <LayoutTemplate
                                  className="h-[18px] w-[18px]"
                                  strokeWidth={2}
                                />
                              </Button>
                            </PopoverTrigger>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            Starter prompts
                          </TooltipContent>
                        </Tooltip>
                        <PopoverContent
                          side="top"
                          align="start"
                          sideOffset={10}
                          className="w-[min(18rem,calc(100vw-2rem))] border-border/55 bg-card/95 p-2 shadow-2xl backdrop-blur-xl dark:bg-zinc-950/96 z-[100]"
                        >
                          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Insert into prompt
                          </p>
                          <div className="flex flex-col gap-1">
                            {SCHEMA_QUICK_PROMPTS.map((text) => (
                              <Button
                                key={text}
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-auto justify-start whitespace-normal rounded-lg px-2 py-2 text-left text-xs font-normal"
                                disabled={aiBusy}
                                onClick={() => {
                                  setChatInput((prev) =>
                                    prev.trim()
                                      ? `${prev.trim()}\n\n${text}`
                                      : text
                                  )
                                  setPromptTemplatesOpen(false)
                                  chatComposerRef.current?.focus()
                                }}
                              >
                                {text}
                              </Button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                            aria-label="Open agent activity log"
                            onClick={() => setAgentLogExpanded(true)}
                          >
                            <History className="h-[18px] w-[18px]" strokeWidth={2} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Activity &amp; history
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <GroqModelPicker
                        value={lastModelId ?? DEFAULT_GROQ_MODEL_ID}
                        onValueChange={(id) => setLastModelId(id)}
                        disabled={aiBusy}
                        highlightVision={pendingAttachments.length > 0}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
                            aria-label="Assistant tips"
                            onClick={() =>
                              toast.message('Schema assistant', {
                                description:
                                  'Use plain language for tables and relationships. Pick a Deep model for normalization tradeoffs; Instant for quick drafts.',
                              })
                            }
                          >
                            <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[14rem] text-xs">
                          Tips: plain-language schema · match model to task
                        </TooltipContent>
                      </Tooltip>
                      <Button
                        type="button"
                        size="icon"
                        disabled={
                          aiBusy ||
                          (!chatInput.trim() && pendingAttachments.length === 0)
                        }
                        className="h-9 w-9 shrink-0 rounded-full bg-foreground text-background shadow-md hover:bg-foreground/90 dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
                        aria-label="Send prompt"
                        onClick={() => void submitComposer()}
                      >
                        {aiBusy ? (
                          <span className="text-xs font-semibold">…</span>
                        ) : (
                          <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={!!imageLightboxSrc}
        onOpenChange={(open) => !open && setImageLightboxSrc(null)}
      >
        <DialogContent className="max-h-[96vh] max-w-[96vw] border-border/50 bg-zinc-950/97 p-3 shadow-2xl sm:max-w-[96vw]">
          <DialogHeader className="sr-only">
            <DialogTitle>Image preview</DialogTitle>
          </DialogHeader>
          {imageLightboxSrc ? (
            <img
              src={imageLightboxSrc}
              alt=""
              className="mx-auto max-h-[min(92vh,1200px)] w-auto max-w-full rounded-lg object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={sqlDialogOpen} onOpenChange={setSqlDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Schema SQL</DialogTitle>
            <DialogDescription>
              Edits sync to the canvas. Parse errors show inline.
            </DialogDescription>
          </DialogHeader>
          <div className="h-[min(70vh,480px)] min-h-[240px]">
            <MonacoSqlEditor
              value={editorValue}
              onChange={handleEditorChange}
              onExecute={() => {}}
              className="h-full rounded-md border border-border"
              fillHeight
              hideNextActionSuggestions
              disabled={loading}
            />
          </div>
          {parseError ? (
            <p className="text-xs text-destructive">{parseError}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSqlDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SchemaEditTableDialog />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              This removes the project and its saved schema from your device.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

const FlowCanvas = dynamic(
  () =>
    import('@/components/flow-canvas').then((mod) => ({
      default: mod.FlowCanvas,
    })),
  { ssr: false }
)
