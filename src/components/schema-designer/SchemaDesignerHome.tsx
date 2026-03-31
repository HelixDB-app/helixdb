'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Layers3, Sparkles } from 'lucide-react'
import { ErrorToast } from '@/components/schema-designer/ErrorToast'
import { ProjectSidebar } from '@/components/schema-designer/ProjectSidebar'
import { PromptComposer } from '@/components/schema-designer/PromptComposer'
import { ThemeToggle } from '@/components/schema-designer/ThemeToggle'
import {
  DEFAULT_GENERATION_OPTIONS,
  PROJECT_DRAFT_SESSION_KEY,
  SCHEMA_DESIGNER_FEATURES,
  SCHEMA_DESIGNER_SUGGESTIONS,
  SCHEMA_TEMPLATES,
} from '@/lib/schema-designer/constants'
import { getDefaultModel } from '@/lib/schema-designer/project-utils'
import { getSchemaDesignerWorkspaceHref } from '@/lib/schema-designer/routes'
import { useSchemaProjects } from '@/hooks/useSchemaProjects'

export function SchemaDesignerHome() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(getDefaultModel())
  const [options, setOptions] = useState(DEFAULT_GENERATION_OPTIONS)
  const [submitting, setSubmitting] = useState(false)
  const { groupedProjects, loading, error, createProject } = useSchemaProjects(query)

  const activeTemplates = useMemo(() => SCHEMA_TEMPLATES.slice(0, 4), [])

  const handleCreateProject = async (prefillPrompt?: string) => {
    setSubmitting(true)
    try {
      const nextPrompt = prefillPrompt ?? prompt
      const project = await createProject({
        prompt: nextPrompt,
        model,
        options,
        name: nextPrompt.trim() ? nextPrompt.trim().slice(0, 44) : 'Untitled schema project',
        description: 'AI-powered schema design session',
      })
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(
          PROJECT_DRAFT_SESSION_KEY,
          JSON.stringify({
            projectId: project.id,
            prompt: nextPrompt,
            model,
            options,
          })
        )
      }
      router.push(getSchemaDesignerWorkspaceHref(project.id))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#090909] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.16),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(6,182,212,0.12),_transparent_28%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:22px_22px] opacity-30" />

      <div className="relative z-10 flex min-h-dvh flex-col px-4 py-4 sm:px-6">
        <header className="mb-4 flex items-center justify-between gap-4 rounded-[28px] border border-white/8 bg-black/30 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-black shadow-lg shadow-indigo-500/20">
              <Layers3 className="h-5 w-5" />
            </span>
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-zinc-500">Workspace</p>
              <h1 className="text-xl font-semibold tracking-tight">Schema Designer</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <ProjectSidebar
            groupedProjects={groupedProjects}
            loading={loading}
            query={query}
            onQueryChange={setQuery}
            onCreate={() => void handleCreateProject()}
          />

          <main className="flex min-h-[70vh] flex-col items-center justify-center rounded-[34px] border border-white/8 bg-[#111111]/80 px-6 py-10 shadow-[0_30px_100px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:px-10">
            <div className="mb-8 max-w-4xl text-center">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.24em] text-zinc-400">
                <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
                Google Stitch-inspired desktop flow
              </div>
              <h2 className="text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl">
                Welcome to Schema Designer.
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-balance text-lg leading-8 text-zinc-400">
                Describe your app, choose the right model, and we’ll turn the brief into a production-minded database architecture with a live, editable ERD canvas.
              </p>
            </div>

            <div className="mb-5 flex max-w-4xl flex-wrap items-center justify-center gap-2">
              {SCHEMA_DESIGNER_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setPrompt(suggestion)}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
                >
                  {suggestion}
                </button>
              ))}
            </div>

            <PromptComposer
              prompt={prompt}
              onPromptChange={setPrompt}
              model={model}
              onModelChange={setModel}
              options={options}
              onOptionsChange={(updates) => setOptions((current) => ({ ...current, ...updates }))}
              onSubmit={() => void handleCreateProject()}
              submitting={submitting}
            />

            <div className="mt-8 grid w-full max-w-5xl gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-[28px] border border-white/10 bg-black/20 p-5 backdrop-blur-xl">
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Template jumpstart</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {activeTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => void handleCreateProject(template.prompt)}
                      className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4 text-left transition hover:border-white/20 hover:bg-white/[0.06]"
                    >
                      <p className="text-sm font-semibold text-white">{template.name}</p>
                      <p className="mt-2 text-sm leading-6 text-zinc-400">{template.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-[28px] border border-white/10 bg-black/20 p-5 backdrop-blur-xl">
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Module feature set</p>
                <div className="mt-4 space-y-3">
                  {SCHEMA_DESIGNER_FEATURES.map((feature) => (
                    <div key={feature} className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-zinc-300">
                      {feature}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
      <ErrorToast error={error ? { type: 'NETWORK_ERROR', message: error } : null} />
    </div>
  )
}
