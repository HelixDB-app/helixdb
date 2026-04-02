'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Files,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/theme-toggle'
import { listenSchemaShare } from '@/lib/desktop-shell'
import { isTauri } from '@/lib/tauri-runtime'
import {
  aiPayloadToSchemaTables,
  aiFeaturesToSchemaExtras,
  firstTableAccentColor,
  markdownToSchemaDocumentation,
  parseAiDocumentationMarkdown,
  parseAiFeaturesJsonBlock,
  parseAiSchemaJsonBlock,
} from '@/lib/ai-schema-from-json'
import {
  cacheProjectsToLocal,
  deleteLocalProject,
  loadLocalProject,
  loadLocalProjectSummaries,
  saveLocalProject,
  setPendingProject,
} from '@/lib/schema-designer-storage'
import {
  schemaDesignerDeleteProject,
  schemaDesignerGroqHasApiKey,
  schemaDesignerGroqSetApiKey,
  schemaDesignerLoadAll,
  schemaDesignerSaveProject,
} from '@/lib/tauri'
import {
  buildNewProject,
  projectToStore,
  projectToSummary,
  storeToProject,
} from '@/lib/schema-designer-utils'
import type { SchemaProject, SchemaProjectSummary } from '@/lib/schema-designer-types'
import {
  DEFAULT_GROQ_MODEL_ID,
  groqModelsGrouped,
  providerForSchemaAiModel,
} from '@/lib/groq-models'
import { SCHEMA_TEMPLATES } from '@/lib/schema-templates'
import { useSchemaAiStream } from '@/lib/use-schema-ai-stream'
import {
  loadSchemaAiPipelineSettings,
  saveSchemaAiPipelineSettings,
} from '@/lib/schema-ai-pipeline-settings'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function createProjectId(): string {
  return `project-${Date.now()}`
}

type DateBucket = 'Today' | 'Yesterday' | 'Last 7 days' | 'Last 30 days' | 'Older'

function startOfDay(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

function projectDateBucket(updatedAt: string): DateBucket {
  const t = new Date(updatedAt).getTime()
  if (Number.isNaN(t)) return 'Older'
  const now = new Date()
  const day = 86400000
  const diff = startOfDay(now) - startOfDay(new Date(t))
  if (diff === 0) return 'Today'
  if (diff === day) return 'Yesterday'
  if (diff < 7 * day) return 'Last 7 days'
  if (diff < 30 * day) return 'Last 30 days'
  return 'Older'
}

function groupByBucket(
  list: SchemaProjectSummary[]
): { bucket: DateBucket; items: SchemaProjectSummary[] }[] {
  const order: DateBucket[] = [
    'Today',
    'Yesterday',
    'Last 7 days',
    'Last 30 days',
    'Older',
  ]
  const map = new Map<DateBucket, SchemaProjectSummary[]>()
  for (const b of order) map.set(b, [])
  for (const p of list) {
    map.get(projectDateBucket(p.updated_at))!.push(p)
  }
  return order.map((bucket) => ({ bucket, items: map.get(bucket)! })).filter((g) => g.items.length > 0)
}

function narrativeAfterJsonFence(full: string): string {
  const m = full.match(/```json\s*[\s\S]*?```\s*([\s\S]*)/i)
  return (m ? m[1] : full).trim()
}

type SyncStatus = 'idle' | 'syncing' | 'error'
type GenerationErrorType = 'validation' | 'network' | 'rate_limit' | 'parse' | 'cancelled' | 'unknown'
type GenerationError = { type: GenerationErrorType; message: string; retryable: boolean }

function toGenerationError(message: string): GenerationError {
  const x = message.toLowerCase()
  if (x.includes('cancel')) {
    return { type: 'cancelled', message: 'Generation cancelled. Your prompt is preserved.', retryable: true }
  }
  if (x.includes('429') || x.includes('rate limit')) {
    return {
      type: 'rate_limit',
      message: 'Model rate-limited. Retrying or switching models may help.',
      retryable: true,
    }
  }
  if (
    x.includes('timeout') ||
    x.includes('network') ||
    x.includes('request failed') ||
    x.includes('connection')
  ) {
    return {
      type: 'network',
      message: 'Network issue while generating schema. Check connection and retry.',
      retryable: true,
    }
  }
  return { type: 'unknown', message, retryable: true }
}

export default function SchemaProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<SchemaProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SchemaProjectSummary | null>(
    null
  )
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)

  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState(DEFAULT_GROQ_MODEL_ID)
  const [dbTarget, setDbTarget] = useState('postgresql')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [temperature, setTemperature] = useState(0.4)
  const [maxTokens, setMaxTokens] = useState(8192)
  const [outputFormat, setOutputFormat] = useState('detailed')
  const [auditColumns, setAuditColumns] = useState(true)
  const [includeIndexes, setIncludeIndexes] = useState(true)
  const [includeEnums, setIncludeEnums] = useState(true)
  const [sampleData, setSampleData] = useState(false)
  const [normalization, setNormalization] = useState('3nf')
  const [namingConvention, setNamingConvention] = useState('snake_case')
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [groqKeyInput, setGroqKeyInput] = useState('')
  const [generationError, setGenerationError] = useState<GenerationError | null>(null)
  const [generationAttempt, setGenerationAttempt] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [runFeaturesPhase, setRunFeaturesPhase] = useState(true)
  const [runDocsPhase, setRunDocsPhase] = useState(true)
  const [runSavingStage, setRunSavingStage] = useState(true)
  const selectedProvider = providerForSchemaAiModel(modelId)

  const { streaming, buffer, agentLog, stage, stageError, retryCount, currentProvider, startStream, cancelStream } =
    useSchemaAiStream()

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setProjects(loadLocalProjectSummaries())
    })
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listenSchemaShare((url) => {
      const m = url.match(/[?&]token=([^&]+)/)
      const raw = m?.[1]
      if (!raw) return
      try {
        const token = decodeURIComponent(raw)
        router.push(`/schema-projects/share?t=${encodeURIComponent(token)}`)
      } catch {
        /* ignore */
      }
    }).then((u) => {
      unlisten = u
    })
    return () => {
      unlisten?.()
    }
  }, [router])

  useEffect(() => {
    const settings = loadSchemaAiPipelineSettings()
    setRunFeaturesPhase(settings.runFeaturesPhase)
    setRunDocsPhase(settings.runDocsPhase)
    setRunSavingStage(settings.runSavingStage)
  }, [])

  useEffect(() => {
    saveSchemaAiPipelineSettings({
      runFeaturesPhase,
      runDocsPhase,
      runSavingStage,
    })
  }, [runFeaturesPhase, runDocsPhase, runSavingStage])

  const runRemoteSync = useCallback(() => {
    if (!isTauri()) return
    setSyncStatus('syncing')
    setSyncError(null)
    schemaDesignerLoadAll()
      .then((list) => {
        const summaries = cacheProjectsToLocal(list)
        setProjects(summaries)
        setSyncStatus('idle')
      })
      .catch(() => {
        setSyncStatus('error')
        setSyncError('Could not sync projects from the app runtime.')
      })
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const id = requestAnimationFrame(() => {
      runRemoteSync()
    })
    return () => cancelAnimationFrame(id)
  }, [runRemoteSync])

  const filtered = useMemo(() => {
    if (!query.trim()) return projects
    const q = query.trim().toLowerCase()
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
    )
  }, [projects, query])

  const sidebarGroups = useMemo(() => groupByBucket(filtered), [filtered])

  const showSyncSkeleton = isTauri() && syncStatus === 'syncing'

  const handleCreate = async () => {
    const newId = createProjectId()
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

  const handleDuplicateProject = async (summary: SchemaProjectSummary) => {
    const source = loadLocalProject(summary.id)
    if (!source) {
      toast.error('Could not load project data.')
      return
    }
    const now = new Date().toISOString()
    const newId = createProjectId()
    const store = projectToStore(source)
    const dup = storeToProject(
      {
        ...store,
        projectId: newId,
        projectName: `${store.projectName?.trim() || 'Untitled'} Copy`,
        projectDescription: store.projectDescription,
        projectAppType: store.projectAppType,
        projectCreatedAt: now,
        projectUpdatedAt: now,
      },
      now
    )
    const next = saveLocalProject(dup)
    setProjects(next)
    if (isTauri()) {
      try {
        const list = await schemaDesignerSaveProject(dup)
        setProjects(cacheProjectsToLocal(list))
      } catch {
        toast.error('Project was saved locally but could not sync to the app.')
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

  const handleGenerate = async () => {
    setGenerationError(null)
    if (!prompt.trim()) {
      setGenerationError({
        type: 'validation',
        message: 'Describe what you want to build before generating.',
        retryable: false,
      })
      return
    }
    if (!isTauri()) {
      toast.error('AI generation runs in the pgStudio desktop app.')
      return
    }
    const provider = providerForSchemaAiModel(modelId)
    if (provider !== 'worker') {
      try {
        const hasKey = await schemaDesignerGroqHasApiKey()
        if (!hasKey) {
          setKeyDialogOpen(true)
          return
        }
      } catch {
        setKeyDialogOpen(true)
        return
      }
    }

    const newId = createProjectId()
    const title =
      prompt.trim().split('\n')[0]?.slice(0, 72).trim() || 'AI schema project'
    const now = new Date().toISOString()
    const userMsg = {
      id: `msg-${Date.now()}-u`,
      role: 'user' as const,
      content: prompt.trim(),
      created_at: now,
    }
    const project: SchemaProject = {
      ...buildNewProject({ id: newId, name: title, description: '' }),
      messages: [userMsg],
      last_model_id: modelId,
      last_generation_options_json: JSON.stringify({
        dbTarget,
        outputFormat,
        temperature,
        maxTokens,
        runFeaturesPhase,
        runDocsPhase,
        runSavingStage,
      }),
    }
    saveLocalProject(project)
    setProjects((prev) => [projectToSummary(project), ...prev])
    if (isTauri()) {
      try {
        const list = await schemaDesignerSaveProject(project)
        setProjects(cacheProjectsToLocal(list))
      } catch {
        toast.error('Could not sync new project to app storage.')
      }
    }

    const optionsPayload = {
      provider,
      databaseTarget: dbTarget,
      outputFormat,
      auditColumns,
      includeIndexes,
      includeEnums,
      includeSampleData: sampleData,
      normalization,
      namingConvention,
      reasoningEffort:
        modelId.includes('r1') ||
        modelId.includes('qwq') ||
        modelId.includes('compound')
          ? reasoningEffort
          : undefined,
      runFeaturesPhase,
      runDocsPhase,
      runSavingStage,
    }

    await startStream(
      {
        projectId: newId,
        messages: [{ role: 'user', content: prompt.trim() }],
        model: modelId,
        temperature,
        maxTokens,
        options: optionsPayload,
      },
      {
        onDone: async (err, fullText) => {
          if (err && err !== 'Cancelled') {
            setGenerationError(toGenerationError(err))
            return
          }
          if (err === 'Cancelled') {
            setGenerationError({
              type: 'cancelled',
              message: 'Generation cancelled. You can retry with the same prompt.',
              retryable: true,
            })
            return
          }

          const payload = parseAiSchemaJsonBlock(fullText)
          if (!payload) {
            setGenerationError({
              type: 'parse',
              message: 'Could not parse schema JSON from AI output.',
              retryable: true,
            })
            return
          }
          const schemaTables = aiPayloadToSchemaTables(payload)
          const featurePayload = runFeaturesPhase ? parseAiFeaturesJsonBlock(fullText) : null
          const extras = aiFeaturesToSchemaExtras(featurePayload, schemaTables)
          const accent = firstTableAccentColor(schemaTables)
          const narrative = runDocsPhase
            ? parseAiDocumentationMarkdown(fullText) || narrativeAfterJsonFence(fullText)
            : narrativeAfterJsonFence(fullText)
          const assistantMsg = {
            id: `msg-${Date.now()}-a`,
            role: 'assistant' as const,
            content: narrative.slice(0, 20000),
            created_at: new Date().toISOString(),
            model: modelId,
          }
          const snapTables = structuredClone(schemaTables)
          const versionHistory = [
            {
              id: `ver-${Date.now()}`,
              label: 'Initial AI generation',
              timestamp: new Date().toISOString(),
              tables: snapTables,
              conversation_turn_id: assistantMsg.id,
            },
          ]
          const updated: SchemaProject = {
            ...project,
            name: title,
            tables: schemaTables,
            updated_at: new Date().toISOString(),
            thumbnail_color: accent,
            ai_panel_markdown: narrative,
            messages: [...(project.messages ?? []), assistantMsg],
            version_history: versionHistory,
            functions: extras.functions,
            triggers: extras.triggers,
            extensions: extras.extensions,
            cron_jobs: extras.cronJobs,
            documentation: runDocsPhase ? markdownToSchemaDocumentation(narrative) : null,
            code: '',
          }
          saveLocalProject(updated)
          setPendingProject(updated)
          if (isTauri()) {
            try {
              const list = await schemaDesignerSaveProject(updated)
              setProjects(cacheProjectsToLocal(list))
            } catch {
              toast.error('Saved locally; cloud sync failed.')
            }
          } else {
            setProjects(loadLocalProjectSummaries())
          }
          toast.success('Schema generated')
          setGenerationError(null)
          router.replace(`/schema-projects/designer?id=${newId}`)
        },
        usePipeline: true,
      }
    )
  }

  const designerHref = (id: string) =>
    `/schema-projects/designer?id=${encodeURIComponent(id)}`

  const modelGroups = groqModelsGrouped()
  const visiblePipelineStages = useMemo(() => {
    const stages: Array<'schema' | 'features' | 'docs' | 'saving'> = ['schema']
    if (runFeaturesPhase) stages.push('features')
    if (runDocsPhase) stages.push('docs')
    if (runSavingStage) stages.push('saving')
    return stages
  }, [runDocsPhase, runFeaturesPhase, runSavingStage])

  return (
    <TooltipProvider delayDuration={300}>
      <main className="flex min-h-dvh bg-background">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-border/60 bg-muted/15">
          <div className="border-b border-border/50 p-3">
            <div className="mb-3 flex items-center gap-2">
              <Link href="/">
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <Database className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold tracking-tight">AI Schema</span>
            </div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="h-9 bg-background/80"
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-6 p-3 pr-2 pb-24">
              {showSyncSkeleton ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-lg" />
                  ))}
                </div>
              ) : sidebarGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground px-1">
                  No projects yet. Generate one from the welcome screen.
                </p>
              ) : (
                sidebarGroups.map((group) => (
                  <div key={group.bucket}>
                    <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.bucket}
                    </p>
                    <ul className="space-y-1">
                      {group.items.map((p) => (
                        <li key={p.id}>
                          <Link
                            href={designerHref(p.id)}
                            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60"
                          >
                            <span
                              className="h-8 w-8 shrink-0 rounded-md border border-border/50"
                              style={{
                                backgroundColor: p.thumbnail_color || 'hsl(var(--muted))',
                              }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{p.name}</span>
                              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                <Calendar className="h-3 w-3 shrink-0" />
                                {formatDate(p.updated_at)}
                              </span>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
          <div className="mt-auto space-y-2 border-t border-border/50 p-3">
            <Button className="w-full gap-2" onClick={() => void handleCreate()}>
              <Plus className="h-4 w-4" />
              New project
            </Button>
            <div className="flex items-center justify-between rounded-lg border border-border/50 bg-background/50 px-2 py-1.5">
              <span className="text-xs text-muted-foreground">Theme</span>
              <ThemeToggle />
            </div>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-border/40 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  Welcome to AI Schema Designer
                </h1>
                <p className="text-sm text-muted-foreground">
                  Describe your product; we generate a visual database design with managed AI models.
                </p>
              </div>
              {syncStatus === 'syncing' ? (
                <Badge variant="outline">Syncing…</Badge>
              ) : null}
            </div>
          </header>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
              {syncError ? (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertTitle>Sync failed</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span>{syncError}</span>
                    {isTauri() ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => runRemoteSync()}>
                        Retry
                      </Button>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-1.5">
                {SCHEMA_TEMPLATES.map((tpl) => (
                  <Button
                    key={tpl.id}
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 rounded-full text-[11px]"
                    onClick={() => setPrompt(tpl.prompt)}
                  >
                    {tpl.title}
                  </Button>
                ))}
              </div>

              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the app or domain — e.g. multi-tenant SaaS with orgs, billing, and audit logs…"
                className="min-h-[160px] resize-y rounded-2xl border-border/60 bg-muted/20 text-base"
              />

              <div className="flex flex-col gap-4 rounded-2xl border border-border/50 bg-muted/10 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Model</Label>
                    <Select value={modelId} onValueChange={setModelId}>
                      <SelectTrigger className="h-10 rounded-xl bg-background/80">
                        <Sparkles className="mr-2 h-3.5 w-3.5 text-primary" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {modelGroups.map((g) => (
                          <SelectGroup key={g.tier}>
                            <SelectLabel>{g.label}</SelectLabel>
                            {g.models.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                <span className="font-medium">{m.label}</span>
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {m.speedBadge} · {m.contextWindow.toLocaleString()} ctx
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Database</Label>
                    <Select value={dbTarget} onValueChange={setDbTarget}>
                      <SelectTrigger className="h-10 rounded-xl bg-background/80">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="postgresql">PostgreSQL</SelectItem>
                        <SelectItem value="mysql">MySQL</SelectItem>
                        <SelectItem value="mongodb">MongoDB</SelectItem>
                        <SelectItem value="sqlite">SQLite</SelectItem>
                        <SelectItem value="multi">Multi-DB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setAdvancedOpen((o) => !o)}
                  className="flex items-center gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {advancedOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  Advanced options
                </button>
                <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">AI pipeline settings</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                    Configure
                  </Button>
                </div>

                {advancedOpen ? (
                  <div className="space-y-4 border-t border-border/40 pt-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <div className="mb-1 flex justify-between text-xs">
                          <Label>Temperature</Label>
                          <span className="text-muted-foreground">{temperature.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.05}
                          value={temperature}
                          onChange={(e) => setTemperature(Number(e.target.value))}
                          className="w-full accent-primary"
                        />
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between text-xs">
                          <Label>Max tokens</Label>
                          <span className="text-muted-foreground">{maxTokens}</span>
                        </div>
                        <input
                          type="range"
                          min={1024}
                          max={16384}
                          step={256}
                          value={maxTokens}
                          onChange={(e) => setMaxTokens(Number(e.target.value))}
                          className="w-full accent-primary"
                        />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label className="text-xs">Output format</Label>
                        <Select value={outputFormat} onValueChange={setOutputFormat}>
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="detailed">Detailed</SelectItem>
                            <SelectItem value="minimal">Minimal</SelectItem>
                            <SelectItem value="with_indexes">With indexes</SelectItem>
                            <SelectItem value="with_sample_data">With sample data</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Normalization</Label>
                        <Select value={normalization} onValueChange={setNormalization}>
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="denormalized">Denormalized</SelectItem>
                            <SelectItem value="1nf">1NF</SelectItem>
                            <SelectItem value="2nf">2NF</SelectItem>
                            <SelectItem value="3nf">3NF</SelectItem>
                            <SelectItem value="bcnf">BCNF</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label className="text-xs">Naming</Label>
                        <Select value={namingConvention} onValueChange={setNamingConvention}>
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="snake_case">snake_case</SelectItem>
                            <SelectItem value="camelCase">camelCase</SelectItem>
                            <SelectItem value="PascalCase">PascalCase</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Reasoning (R1 / QwQ / Compound)</Label>
                        <Select value={reasoningEffort} onValueChange={setReasoningEffort}>
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                        <Label className="text-xs">Audit columns</Label>
                        <Switch checked={auditColumns} onCheckedChange={setAuditColumns} />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                        <Label className="text-xs">Indexes in output</Label>
                        <Switch checked={includeIndexes} onCheckedChange={setIncludeIndexes} />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                        <Label className="text-xs">Enums</Label>
                        <Switch checked={includeEnums} onCheckedChange={setIncludeEnums} />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                        <Label className="text-xs">Sample data hints</Label>
                        <Switch checked={sampleData} onCheckedChange={setSampleData} />
                      </div>
                    </div>
                  </div>
                ) : null}

                <Button
                  size="lg"
                  className="h-12 w-full rounded-xl text-base"
                  disabled={streaming}
                  onClick={() => void handleGenerate()}
                >
                  {streaming ? 'Generating…' : 'Generate schema'}
                </Button>
                {streaming ? (
                  <div className="rounded-xl border border-border/60 bg-card/60 p-3">
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <span className="font-medium">Agent pipeline</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          void cancelStream().then(() => {
                            setGenerationError(null)
                          })
                        }
                      >
                        Cancel
                      </Button>
                    </div>
                    <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
                      {visiblePipelineStages.map((s) => {
                        const doneOrder = ['schema', 'features', 'docs', 'saving', 'done'] as const
                        const current = doneOrder.indexOf(stage as (typeof doneOrder)[number])
                        const mine = doneOrder.indexOf(s)
                        const isDone = current > mine
                        const isActive = stage === s
                        return (
                          <span
                            key={s}
                            className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-1"
                          >
                            {isDone ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : null}
                            {isActive ? <Loader2 className="h-3 w-3 animate-spin text-primary" /> : null}
                            {!isDone && !isActive ? <span className="h-3 w-3 rounded-full bg-muted" /> : null}
                            {s}
                          </span>
                        )
                      })}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      provider: {currentProvider} · retries: {retryCount}
                    </div>
                    {stageError ? (
                      <div className="mt-2 text-xs text-destructive">{stageError}</div>
                    ) : null}
                    <div className="mt-2 max-h-24 overflow-hidden text-[10px] text-muted-foreground/80 line-clamp-4">
                      {buffer.slice(-280)}
                    </div>
                    {agentLog.length > 0 ? (
                      <div className="mt-2 max-h-20 overflow-auto text-[10px] text-muted-foreground">
                        {agentLog.map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {generationError ? (
                  <Alert variant="destructive">
                    <AlertCircle className="size-4" />
                    <AlertTitle>Generation issue</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span>{generationError.message}</span>
                      {generationError.retryable ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setGenerationAttempt((x) => x + 1)
                              void handleGenerate()
                            }}
                          >
                            Retry {generationAttempt > 0 ? `(${generationAttempt})` : ''}
                          </Button>
                        </div>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {filtered.slice(0, 4).map((p) => (
                  <Card key={p.id} className="border-border/50 bg-card/40">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <Link
                          href={designerHref(p.id)}
                          className="min-w-0 font-medium hover:underline"
                        >
                          {p.name}
                        </Link>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={designerHref(p.id)}>Open</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void handleDuplicateProject(p)}>
                              <Files className="mr-2 h-4 w-4" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteTarget(p)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground">
                      {p.table_count} tables · {formatDate(p.updated_at)}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </div>
        </div>

        <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete project?</DialogTitle>
              <DialogDescription>
                This removes the project and its saved schema from your device.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={keyDialogOpen} onOpenChange={setKeyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>API credentials required</DialogTitle>
              <DialogDescription>
                The default Worker model is managed automatically. For Groq models, store your key in
                keychain or set{' '}
                <code className="text-xs">
                  {selectedProvider === 'openrouter'
                    ? 'OPENROUTER_API_KEY'
                    : selectedProvider === 'gemini'
                      ? 'GEMINI_API_KEY'
                      : 'GROQ_API_KEY'}
                </code>
                . For Cloudflare models, set{' '}
                <code className="text-xs">CLOUDFLARE_ACCOUNT_ID</code> and{' '}
                <code className="text-xs">CLOUDFLARE_AUTH_TOKEN</code> before launching the app.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="groq-key">API key</Label>
              <Input
                id="groq-key"
                type="password"
                autoComplete="off"
                placeholder={
                  selectedProvider === 'openrouter'
                    ? 'sk-or-v1-…'
                    : selectedProvider === 'gemini'
                      ? 'AIza...'
                      : 'gsk_…'
                }
                value={groqKeyInput}
                onChange={(e) => setGroqKeyInput(e.target.value)}
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setKeyDialogOpen(false)}>
                Close
              </Button>
              <Button asChild variant="secondary">
                <a
                  href={
                    selectedProvider === 'openrouter'
                      ? 'https://openrouter.ai/keys'
                      : selectedProvider === 'gemini'
                        ? 'https://aistudio.google.com/app/apikey'
                      : 'https://console.groq.com/keys'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get a key
                </a>
              </Button>
              <Button
                onClick={() => {
                  const k = groqKeyInput.trim()
                  if (!k) {
                    toast.error('Paste an API key')
                    return
                  }
                  if (selectedProvider === 'gemini') {
                    toast.message('Use environment variable', {
                      description:
                        'Set GEMINI_API_KEY (or GOOGLE_API_KEY) in your app environment and restart the app.',
                    })
                    return
                  }
                  void schemaDesignerGroqSetApiKey(k)
                    .then(() => {
                      toast.success('API key saved')
                      setKeyDialogOpen(false)
                      setGroqKeyInput('')
                    })
                    .catch((e: unknown) => {
                      toast.error(e instanceof Error ? e.message : 'Could not save key')
                    })
                }}
              >
                {selectedProvider === 'gemini' ? 'Use env var for Gemini' : 'Save to keychain'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>AI schema pipeline settings</DialogTitle>
              <DialogDescription>
                Choose which generation phases run before opening the schema designer.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                <div>
                  <Label className="text-xs">Generate features</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Calls the features phase to add functions, triggers, extensions, and cron jobs.
                  </p>
                </div>
                <Switch checked={runFeaturesPhase} onCheckedChange={setRunFeaturesPhase} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                <div>
                  <Label className="text-xs">Generate docs</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Calls the docs phase to produce markdown documentation and AI narrative.
                  </p>
                </div>
                <Switch checked={runDocsPhase} onCheckedChange={setRunDocsPhase} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                <div>
                  <Label className="text-xs">Show saving stage</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Displays the final saving step in the pipeline tracker.
                  </p>
                </div>
                <Switch checked={runSavingStage} onCheckedChange={setRunSavingStage} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setSettingsOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  )
}
