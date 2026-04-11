'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, FileText, PencilLine, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { aiSchemaEditHref } from '@/lib/ai-schema-routes'
import { loadAISchemaProject } from '@/lib/ai-schema-project-storage'
import type { AISchemaProject } from '@/lib/schema-designer-types'

function collectSql(project: AISchemaProject): string {
  const blocks = project.schema?.sql_blocks ?? {}
  return Object.values(blocks).filter(Boolean).join('\n\n')
}

export function ProjectViewClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const idParam = searchParams.get('id')
  const projectId = idParam ? decodeURIComponent(idParam) : null

  const project = useMemo(() => {
    if (!projectId) return null
    return loadAISchemaProject(projectId)
  }, [projectId])

  const sql = useMemo(() => (project ? collectSql(project) : ''), [project])

  if (!projectId) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-muted-foreground">No project selected.</p>
        <Button asChild>
          <Link href="/schema-projects/">Back to projects</Link>
        </Button>
      </main>
    )
  }

  if (!project) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-muted-foreground">Project not found.</p>
        <Button asChild>
          <Link href="/schema-projects/">Back to projects</Link>
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/schema-projects/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{project.name}</h1>
            <p className="text-sm text-muted-foreground">{project.description || 'No description'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={aiSchemaEditHref(project.id)}>
              <PencilLine className="mr-2 h-4 w-4" />
              Edit
            </Link>
          </Button>
          <Button
            onClick={() =>
              router.push(
                `/schema-projects/ai-designer/?projectId=${encodeURIComponent(project.id)}`
              )
            }
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Improve with AI
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project Prompt</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{project.prompt}</CardContent>
      </Card>

      <Tabs defaultValue="sql">
        <TabsList>
          <TabsTrigger value="sql">SQL</TabsTrigger>
          <TabsTrigger value="docs">Docs</TabsTrigger>
          <TabsTrigger value="meta">Meta</TabsTrigger>
        </TabsList>
        <TabsContent value="sql">
          <Card>
            <CardContent className="p-4">
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">{sql || '-- no sql output --'}</pre>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="docs">
          <Card>
            <CardContent className="p-4">
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">
                {project.schema.schema_doc || 'No documentation generated.'}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="meta">
          <Card>
            <CardContent className="space-y-2 p-4 text-sm">
              <p>Updated: {new Date(project.updated_at).toLocaleString()}</p>
              <p>Tables: {project.schema.react_flow_graph?.nodes?.length ?? 0}</p>
              <p className="inline-flex items-center gap-1 text-muted-foreground">
                <FileText className="h-4 w-4" />
                Model: {project.model || 'unknown'}
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  )
}
