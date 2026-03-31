'use client'

import { Bot, Sparkles, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { GROQ_MODELS } from '@/lib/schema-designer/constants'
import type { GroqModelOption } from '@/lib/schema-designer/types'

function iconForModel(model: GroqModelOption) {
  if (model.badge === 'Fastest') return <Zap className="h-3.5 w-3.5" />
  if (model.badge === 'Reasoning' || model.badge === 'Agentic') {
    return <Sparkles className="h-3.5 w-3.5" />
  }
  return <Bot className="h-3.5 w-3.5" />
}

function findModel(modelId: string): GroqModelOption | undefined {
  return GROQ_MODELS.flatMap((group) => group.models).find((model) => model.id === modelId)
}

export function ModelSelector({
  value,
  onValueChange,
}: {
  value: string
  onValueChange: (value: string) => void
}) {
  const activeModel = findModel(value)

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-11 min-w-[16rem] rounded-2xl border-white/10 bg-white/5 px-4 text-left text-sm text-white shadow-none backdrop-blur-sm">
        <SelectValue>
          {activeModel ? (
            <div className="flex items-center gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-100">
                {iconForModel(activeModel)}
              </span>
              <div className="flex min-w-0 flex-col text-left">
                <span className="truncate font-medium text-white">{activeModel.label}</span>
                <span className="truncate text-xs text-zinc-400">{activeModel.contextWindow ?? 'Context'} · {activeModel.speed ?? 'Fast'}</span>
              </div>
            </div>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="w-[26rem] rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
        {GROQ_MODELS.map((group) => (
          <SelectGroup key={group.group}>
            <SelectLabel className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-[0.24em] text-zinc-500">
              {group.group}
            </SelectLabel>
            {group.models.map((model) => (
              <SelectItem
                key={model.id}
                value={model.id}
                className="rounded-xl px-3 py-3 data-[highlighted]:bg-white/6"
              >
                <div className="flex w-full items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-100">
                    {iconForModel(model)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{model.label}</span>
                      {model.badge ? (
                        <Badge className="rounded-full border-white/10 bg-white/8 px-2 py-0 text-[10px] text-zinc-200">
                          {model.badge}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                      {model.contextWindow ? <span>{model.contextWindow}</span> : null}
                      {model.speed ? <span>{model.speed}</span> : null}
                    </div>
                    {model.description ? (
                      <p className="mt-1 text-xs leading-5 text-zinc-400">{model.description}</p>
                    ) : null}
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
