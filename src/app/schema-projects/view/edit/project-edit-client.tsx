'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { ThemeToggle } from '@/components/theme-toggle'
import { aiSchemaViewHref } from '@/lib/ai-schema-routes'
import {
  loadAISchemaProject,
  saveAISchemaProject,
} from '@/lib/ai-schema-project-storage'
import type { AISchemaProject } from '@/lib/schema-designer-types'

export function ProjectEditClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const idParam = searchParams.get('id')
  const projectId = idParam ? decodeURIComponent(idParam) : null

  const [project, setProject] = useState<AISchemaProject | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setReady(true)
      return
    }
    const loaded = loadAISchemaProject(projectId)
    if (!loaded) {
      setProject(null)
      setReady(true)
      return
    }
    setProject(loaded)
    setName(loaded.name)
    setDescription(loaded.description || '')
    setPrompt(loaded.prompt || '')
    setReady(true)
  }, [projectId])

  const baseline = useMemo(
    () =>
      project
        ? {
            name: project.name,
            description: project.description || '',
            prompt: project.prompt || '',
          }
        : null,
    [project]
  )

  const isDirty = useMemo(() => {
    if (!baseline) return false
    return (
      name.trim() !== baseline.name ||
      description.trim() !== baseline.description ||
      prompt.trim() !== baseline.prompt
    )
  }, [baseline, name, description, prompt])

  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const save = useCallback(async () => {
    if (!project) return
    setSaving(true)
    try {
      const next: AISchemaProject = {
        ...project,
        name: name.trim() || 'Untitled AI Schema',
        description: description.trim(),
        prompt: prompt.trim(),
        updated_at: new Date().toISOString(),
      }
      saveAISchemaProject(next)
      setProject(next)
      toast.success('Project saved')
      router.push(aiSchemaViewHref(project.id))
    } finally {
      setSaving(false)
    }
  }, [project, name, description, prompt, router])

  const goBack = () => {
    if (isDirty) {
      setDiscardOpen(true)
      return
    }
    router.push(project ? aiSchemaViewHref(project.id) : '/schema-projects/')
  }

  const confirmDiscard = () => {
    setDiscardOpen(false)
    router.push(project ? aiSchemaViewHref(project.id) : '/schema-projects/')
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl items-center justify-center px-4 py-12">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    )
  }

  if (!projectId || !project) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-muted-foreground">
          {!projectId ? 'No project selected.' : 'Project not found.'}
        </p>
        <Button asChild>
          <Link href="/schema-projects/">Back to projects</Link>
        </Button>
      </main>
    )
  }

  return (
    <>
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/40 pb-4">
          <div className="flex min-w-0 items-start gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              aria-label="Back"
              onClick={goBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0 space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">Edit project</h1>
              <p className="text-sm text-muted-foreground">
                Update metadata and the prompt used for this schema. Changes are saved only on this device.
              </p>
            </div>
          </div>
          <ThemeToggle />
        </header>

        <Card className="border-border/60 shadow-sm">
          <CardHeader className="space-y-1">
            <CardTitle className="text-base">Details</CardTitle>
            <CardDescription>
              Name and description appear in your project list. The prompt is what you (or AI) used to generate the schema.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Marketplace checkout"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-description">Description</Label>
              <Input
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short summary for the list view"
                autoComplete="off"
              />
            </div>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="project-prompt">Generation prompt</Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {prompt.length} characters
                </span>
              </div>
              <Textarea
                id="project-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the product or domain you designed this schema for…"
                className="min-h-[200px] resize-y font-mono text-sm leading-relaxed"
              />
              <p className="text-xs text-muted-foreground">
                Editing the prompt does not regenerate SQL until you use &quot;Improve with AI&quot; from the project view.
              </p>
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-6 py-4">
            <p className="text-xs text-muted-foreground">
              Last updated: {new Date(project.updated_at).toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={saving} onClick={goBack}>
                Cancel
              </Button>
              <Button type="button" disabled={saving || !isDirty} onClick={() => void save()}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving
                  </>
                ) : (
                  'Save changes'
                )}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </main>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have edits that are not saved yet. If you leave now, those changes will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setDiscardOpen(false)}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDiscard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
