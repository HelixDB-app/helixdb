'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, FileText, Sparkles, Table2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import type { StreamSection, TableSchema } from '@/lib/schema-designer/types'

function SectionCard({ section, defaultOpen = true }: { section: StreamSection; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="rounded-[22px] border border-white/10 bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-white">{section.title}</span>
        <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="border-t border-white/10 px-4 py-3 text-sm leading-7 text-zinc-300 whitespace-pre-wrap">
          {section.content}
        </div>
      ) : null}
    </div>
  )
}

export function StreamingPanel({
  sections,
  streaming,
  reasoningText,
  selectedTable,
}: {
  sections: StreamSection[]
  streaming: boolean
  reasoningText?: string
  selectedTable?: TableSchema | null
}) {
  const stableSections = useMemo(() => {
    if (sections.length > 0) return sections
    return [
      {
        id: 'waiting',
        title: 'Live stream',
        content: streaming
          ? 'The model is preparing the schema narrative…'
          : 'Kick off a generation to see the AI explanation appear here.',
      },
    ]
  }, [sections, streaming])

  return (
    <div className="flex h-full flex-col rounded-[30px] border border-white/8 bg-[#111111]/88 p-4 shadow-[0_24px_70px_rgba(0,0,0,0.36)] backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">AI stream</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Schema narrative</h2>
        </div>
        {streaming ? (
          <Badge className="rounded-full border-emerald-400/20 bg-emerald-500/10 text-emerald-200">
            <Sparkles className="mr-1 h-3 w-3" />
            Streaming
          </Badge>
        ) : null}
      </div>

      {reasoningText ? (
        <div className="mb-4 rounded-[22px] border border-amber-400/10 bg-amber-500/5 px-4 py-3 text-xs leading-6 text-amber-100/80">
          <div className="mb-1 flex items-center gap-2 font-medium text-amber-100">
            <FileText className="h-3.5 w-3.5" />
            Reasoning trace
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap">{reasoningText}</p>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1 pr-2">
        <div className="space-y-3">
          {stableSections.map((section, index) => (
            <SectionCard key={section.id} section={section} defaultOpen={index < 2} />
          ))}
        </div>
      </ScrollArea>

      {selectedTable ? (
        <div className="mt-4 rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
            <Table2 className="h-4 w-4 text-cyan-300" />
            Selected table
          </div>
          <p className="text-sm font-semibold text-white">{selectedTable.name}</p>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{selectedTable.description || 'No description yet.'}</p>
          <p className="mt-3 text-xs text-zinc-500">{selectedTable.columns.length} columns · {selectedTable.indexes.length} indexes</p>
        </div>
      ) : null}
    </div>
  )
}
