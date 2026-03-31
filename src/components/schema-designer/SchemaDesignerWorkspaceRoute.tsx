'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Layers3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SchemaDesignerWorkspace } from '@/components/schema-designer/SchemaDesignerWorkspace'

export function SchemaDesignerWorkspaceRoute() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId')

  if (!projectId) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#090909] px-6 text-white">
        <div className="w-full max-w-xl rounded-[32px] border border-white/10 bg-[#111111]/90 p-8 text-center shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-black">
            <Layers3 className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold">Open a schema project</h1>
          <p className="mt-3 text-sm leading-7 text-zinc-400">
            This workspace needs a `projectId` in the URL. Open a project from the Schema Designer home screen and we’ll load it here.
          </p>
          <Button asChild className="mt-6 rounded-2xl bg-white text-black hover:bg-zinc-200">
            <Link href="/schema-designer">Back to Schema Designer</Link>
          </Button>
        </div>
      </div>
    )
  }

  return <SchemaDesignerWorkspace projectId={projectId} />
}
