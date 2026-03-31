'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { ErrorToast } from '@/components/schema-designer/ErrorToast'
import { SchemaCanvas } from '@/components/schema-designer/SchemaCanvas'
import { StreamingPanel } from '@/components/schema-designer/StreamingPanel'
import { ConversationThread } from '@/components/schema-designer/ConversationThread'
import { ThemeToggle } from '@/components/schema-designer/ThemeToggle'
import { PROJECT_DRAFT_SESSION_KEY } from '@/lib/schema-designer/constants'
import {
  createConversationMessage,
  createSchemaDesignerProject,
  groupSectionsFromMarkdown,
  withUpdatedSchema,
} from '@/lib/schema-designer/project-utils'
import { getProject, upsertProject } from '@/lib/schema-designer/mongoClient'
import { useSchemaStream } from '@/hooks/useSchemaStream'
import { useSchemaDesignerStore } from '@/stores/schema-designer-store'
import type {
  GenerationOptions,
  SchemaData,
  SchemaDesignerProject,
} from '@/lib/schema-designer/types'

function useLatestAssistantNarrative(project: SchemaDesignerProject | null) {
  return useMemo(() => {
    const latest = [...(project?.conversation ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant')
    return latest?.content ?? ''
  }, [project])
}

export function SchemaDesignerWorkspace({ projectId }: { projectId: string }) {
  const {
    project,
    loading,
    selectedModel,
    options,
    selectedTableId,
    selectedRelationshipId,
    hoveredRelationshipId,
    setProject,
    patchProject,
    setLoading,
    setDraftPrompt,
    setSelectedModel,
    setSelectedTableId,
    setSelectedRelationshipId,
    setHoveredRelationshipId,
  } = useSchemaDesignerStore()
  const stream = useSchemaStream()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const projectRef = useRef<SchemaDesignerProject | null>(null)
  const autoStartedRef = useRef(false)
  const [continuing, setContinuing] = useState(false)

  useEffect(() => {
    projectRef.current = project
  }, [project])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const found = await getProject(projectId)
      const nextProject = found ?? createSchemaDesignerProject({ id: projectId })
      if (!found) {
        await upsertProject(nextProject)
      }
      if (cancelled) return
      setProject(nextProject)
      setDraftPrompt(nextProject.prompt)
      setSelectedModel(nextProject.model)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, setDraftPrompt, setLoading, setProject, setSelectedModel])

  useEffect(() => {
    if (!project) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void upsertProject(project)
    }, 500)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [project])

  const latestAssistantNarrative = useLatestAssistantNarrative(project)
  const narrativeSections = useMemo(
    () =>
      stream.status === 'streaming'
        ? stream.sections
        : groupSectionsFromMarkdown(latestAssistantNarrative),
    [latestAssistantNarrative, stream.sections, stream.status]
  )

  const selectedTable = useMemo(
    () => project?.schema?.tables.find((table) => table.id === selectedTableId) ?? null,
    [project?.schema?.tables, selectedTableId]
  )

  const runGeneration = useCallback(async (
    prompt: string,
    model = selectedModel,
    generationOptions = options,
    mode: 'initial' | 'continue' = 'initial'
  ) => {
    const currentProject = projectRef.current ?? createSchemaDesignerProject({ id: projectId })
    const userMessage = createConversationMessage('user', prompt)
    const conversationHistory = [...currentProject.conversation, userMessage]

    const seededProject: SchemaDesignerProject = {
      ...currentProject,
      prompt,
      model,
      conversation: conversationHistory,
      updatedAt: new Date().toISOString(),
    }

    setProject(seededProject)

    const result = await stream.start({
      prompt,
      model,
      options: generationOptions,
      conversationHistory,
    })

    if (!result.schema) {
      return
    }

    const assistantMessage = createConversationMessage(
      'assistant',
      result.narrative || result.rawResponse,
      {
        model,
        schemaSnapshot: JSON.stringify(result.schema),
      }
    )

    const nextProject = withUpdatedSchema(seededProject, result.schema, {
      prompt,
      model,
      createVersion: true,
      versionLabel: mode === 'continue' ? 'Conversation update' : 'Initial generation',
    })

    setProject({
      ...nextProject,
      conversation: [...conversationHistory, assistantMessage],
      canvasState: {
        ...nextProject.canvasState,
        layoutDirection: nextProject.canvasState.layoutDirection,
      },
    })
    toast.success(mode === 'continue' ? 'Schema updated from conversation.' : 'Schema generated.')
  }, [options, projectId, selectedModel, setProject, stream])

  useEffect(() => {
    if (!project || project.schema || project.conversation.length > 0 || autoStartedRef.current) {
      return
    }
    if (typeof window === 'undefined') return
    const raw = window.sessionStorage.getItem(PROJECT_DRAFT_SESSION_KEY)
    if (!raw) return
    try {
      const draft = JSON.parse(raw) as {
        projectId: string
        prompt: string
        model: string
        options: GenerationOptions
      }
      if (draft.projectId !== project.id || !draft.prompt.trim()) return
      autoStartedRef.current = true
      window.sessionStorage.removeItem(PROJECT_DRAFT_SESSION_KEY)
      void runGeneration(draft.prompt, draft.model, draft.options)
    } catch {
      window.sessionStorage.removeItem(PROJECT_DRAFT_SESSION_KEY)
    }
  }, [project, runGeneration])

  const handleSchemaChange = (schema: SchemaData) => {
    patchProject((existing) => ({
      ...existing,
      schema,
      updatedAt: new Date().toISOString(),
      thumbnailColor: schema.tables[0]?.color ?? existing.thumbnailColor,
      canvasState: {
        ...existing.canvasState,
        nodePositions: Object.fromEntries(
          schema.tables
            .filter((table) => table.position)
            .map((table) => [table.id, table.position ?? { x: 0, y: 0 }])
        ),
      },
    }))
  }

  if (!project) {
    return <div className="min-h-dvh bg-[#090909]" />
  }

  return (
    <div className="min-h-dvh bg-[#090909] text-white">
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#0d0d0d]/90 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Link href="/schema-designer">
              <Button variant="ghost" size="icon" className="h-10 w-10 rounded-2xl text-zinc-300 hover:bg-white/10 hover:text-white">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Project</p>
              <Input
                value={project.name}
                onChange={(event) =>
                  patchProject((existing) => ({
                    ...existing,
                    name: event.target.value,
                    updatedAt: new Date().toISOString(),
                  }))
                }
                className="mt-1 h-10 max-w-[22rem] rounded-2xl border-white/10 bg-white/5 text-base font-semibold text-white"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" className="rounded-2xl border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white">
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
            <Button variant="ghost" className="rounded-2xl border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white">
              <Share2 className="mr-2 h-4 w-4" />
              Share
            </Button>
          </div>
        </div>
      </header>

      <main className="h-[calc(100dvh-81px)] px-4 py-4 sm:px-6">
        <ResizablePanelGroup orientation="horizontal" className="gap-4">
          <ResizablePanel defaultSize={24} minSize={20}>
            <StreamingPanel
              sections={narrativeSections}
              streaming={stream.status === 'streaming'}
              reasoningText={stream.reasoningText}
              selectedTable={selectedTable}
            />
          </ResizablePanel>
          <ResizableHandle withHandle className="bg-white/8" />
          <ResizablePanel defaultSize={52} minSize={35}>
            <SchemaCanvas
              schema={project.schema}
              loading={loading || stream.status === 'streaming'}
              layoutDirection={project.canvasState.layoutDirection}
              selectedTableId={selectedTableId}
              selectedRelationshipId={selectedRelationshipId}
              hoveredRelationshipId={hoveredRelationshipId}
              onSchemaChange={handleSchemaChange}
              onLayoutDirectionChange={(direction) =>
                patchProject((existing) => ({
                  ...existing,
                  canvasState: {
                    ...existing.canvasState,
                    layoutDirection: direction,
                  },
                  updatedAt: new Date().toISOString(),
                }))
              }
              onSelectTable={setSelectedTableId}
              onSelectRelationship={setSelectedRelationshipId}
              onHoverRelationship={setHoveredRelationshipId}
              onAskAiModify={(prompt) => {
                if (!selectedTable) return
                void runGeneration(
                  `Update only the ${selectedTable.name} table in the current schema: ${prompt}`,
                  selectedModel,
                  options,
                  'continue'
                )
              }}
            />
          </ResizablePanel>
          <ResizableHandle withHandle className="bg-white/8" />
          <ResizablePanel defaultSize={24} minSize={20}>
            <ConversationThread
              messages={project.conversation}
              submitting={continuing || stream.status === 'streaming'}
              onContinue={async (prompt) => {
                setContinuing(true)
                try {
                  await runGeneration(prompt, selectedModel, options, 'continue')
                } finally {
                  setContinuing(false)
                }
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
      <ErrorToast error={stream.error} />
    </div>
  )
}
