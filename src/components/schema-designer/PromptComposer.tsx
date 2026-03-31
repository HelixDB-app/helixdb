'use client'

import { useState } from 'react'
import { ArrowUpRight, Database, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ModelSelector } from '@/components/schema-designer/ModelSelector'
import { OptionPanel } from '@/components/schema-designer/OptionPanel'
import type { GenerationOptions } from '@/lib/schema-designer/types'

export function PromptComposer({
  prompt,
  onPromptChange,
  model,
  onModelChange,
  options,
  onOptionsChange,
  onSubmit,
  submitting,
}: {
  prompt: string
  onPromptChange: (value: string) => void
  model: string
  onModelChange: (value: string) => void
  options: GenerationOptions
  onOptionsChange: (updates: Partial<GenerationOptions>) => void
  onSubmit: () => void
  submitting?: boolean
}) {
  const [advancedOpen, setAdvancedOpen] = useState(
    options.includeSampleData || options.reasoningEffort !== 'medium'
  )

  return (
    <div className="w-full max-w-4xl rounded-[32px] border border-white/10 bg-[#121212]/80 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">AI schema brief</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Describe your product and let the designer draft the data model.</h2>
        </div>
        <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 md:inline-flex">
          <Sparkles className="h-3.5 w-3.5 text-indigo-300" />
          Live ERD generation
        </span>
      </div>

      <Textarea
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder="e.g. Build me an ecommerce platform with sellers, inventory, carts, orders, returns, payouts, and analytics dashboards."
        className="min-h-[160px] rounded-[28px] border-white/10 bg-white/5 px-5 py-4 text-base leading-7 text-white placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-indigo-400"
      />

      <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
          <ModelSelector value={model} onValueChange={onModelChange} />
          <Select
            value={options.databaseType}
            onValueChange={(value) =>
              onOptionsChange({
                databaseType: value as GenerationOptions['databaseType'],
              })
            }
          >
            <SelectTrigger className="h-11 min-w-[10rem] rounded-2xl border-white/10 bg-white/5 px-4 text-sm text-zinc-100 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
              <SelectItem value="postgresql">PostgreSQL</SelectItem>
              <SelectItem value="mysql">MySQL</SelectItem>
              <SelectItem value="mongodb">MongoDB</SelectItem>
              <SelectItem value="sqlite">SQLite</SelectItem>
              <SelectItem value="multi">Multi-model</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !prompt.trim()}
          className="h-11 rounded-2xl bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 px-5 text-sm font-semibold text-black hover:opacity-90"
        >
          {submitting ? 'Generating…' : 'Generate Schema'}
          <ArrowUpRight className="ml-2 h-4 w-4" />
        </Button>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
        <Database className="h-3.5 w-3.5" />
        Optimized for rich relational schemas, operational metadata, and future export pipelines.
      </div>

      <div className="mt-4">
        <OptionPanel
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          options={options}
          onChange={onOptionsChange}
        />
      </div>
    </div>
  )
}
