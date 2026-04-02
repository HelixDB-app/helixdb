'use client'

import { useMemo, useState } from 'react'
import { Brain, Check, ChevronDown, Sparkles, Zap } from 'lucide-react'
import {
  DEFAULT_GROQ_MODEL_ID,
  getGroqModelById,
  groqModelsGrouped,
  type GroqModelInfo,
} from '@/lib/groq-models'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

function ModelRowIcon({ badge }: { badge: GroqModelInfo['speedBadge'] }) {
  const shell =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/40'
  if (badge === 'Instant' || badge === 'Fast') {
    return (
      <span
        className={cn(
          shell,
          'bg-amber-500/12 text-amber-700 dark:text-amber-400'
        )}
      >
        <Zap className="h-4 w-4" strokeWidth={2} aria-hidden />
      </span>
    )
  }
  if (badge === 'Deep') {
    return (
      <span
        className={cn(
          shell,
          'bg-violet-500/12 text-violet-700 dark:text-violet-400'
        )}
      >
        <Brain className="h-4 w-4" strokeWidth={2} aria-hidden />
      </span>
    )
  }
  return (
    <span className={cn(shell, 'bg-primary/10 text-primary')}>
      <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
    </span>
  )
}

function contextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

export function GroqModelPicker({
  value,
  onValueChange,
  disabled,
  highlightVision = false,
}: {
  value: string
  onValueChange: (id: string) => void
  disabled?: boolean
  /** When true, vision-capable models show a “Vision” badge in the list. */
  highlightVision?: boolean
}) {
  const [open, setOpen] = useState(false)
  const resolvedId = value || DEFAULT_GROQ_MODEL_ID
  const current = useMemo(
    () => getGroqModelById(resolvedId) ?? getGroqModelById(DEFAULT_GROQ_MODEL_ID)!,
    [resolvedId]
  )
  const grouped = useMemo(() => groqModelsGrouped(), [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-9 max-w-[min(12rem,36vw)] shrink-0 gap-1.5 rounded-full border-border/50 bg-muted/35 px-3 text-xs font-semibold shadow-sm hover:bg-muted/55 dark:bg-muted/25 dark:hover:bg-muted/40"
        >
          <span className="truncate">{current.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        className="w-[min(calc(100vw-1.5rem),22rem)] border-border/55 bg-card/95 p-0 text-card-foreground shadow-2xl backdrop-blur-xl dark:bg-zinc-950/96 z-[100]"
      >
        <div className="shrink-0 border-b border-border/45 px-3.5 py-2.5">
          <p className="text-xs font-semibold tracking-tight">AI model</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Models run on Worker, Groq, Cloudflare, or OpenRouter providers.{' '}
            <span className="text-foreground/85">
              Deep = reasoning; Instant / Fast = quick drafts; Balanced =
              everyday schema work.
            </span>
          </p>
        </div>
        <div
          className={cn(
            'min-h-0 max-h-[min(52vh,440px)] overflow-y-auto overflow-x-hidden overscroll-contain',
            'scroll-py-1 [scrollbar-gutter:stable]',
            '[scrollbar-width:thin] [scrollbar-color:color-mix(in_oklch,var(--muted-foreground)_42%,transparent)_transparent]',
            '[&::-webkit-scrollbar]:w-2',
            '[&::-webkit-scrollbar-track]:bg-transparent',
            '[&::-webkit-scrollbar-thumb]:rounded-full',
            '[&::-webkit-scrollbar-thumb]:bg-border/75',
            '[&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45'
          )}
          role="listbox"
          aria-label="Choose a Groq model"
        >
          {grouped.map((group) =>
            group.models.length === 0 ? null : (
              <section
                key={group.tier}
                className="border-b border-border/25 last:border-b-0"
              >
                <header
                  className={cn(
                    'sticky top-0 z-10 px-3 py-2',
                    'border-b border-border/30 bg-card/92 backdrop-blur-md',
                    'dark:bg-zinc-950/92'
                  )}
                >
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </p>
                </header>
                <div className="space-y-0.5 px-1.5 py-1.5">
                  {group.models.map((m) => {
                    const selected = m.id === resolvedId
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          onValueChange(m.id)
                          setOpen(false)
                        }}
                        className={cn(
                          'flex w-full gap-3 rounded-xl px-2 py-2 text-left transition-colors',
                          selected
                            ? 'bg-primary/10 ring-1 ring-primary/20'
                            : 'hover:bg-muted/60'
                        )}
                      >
                        <ModelRowIcon badge={m.speedBadge} />
                        <div className="min-w-0 flex-1 py-0.5">
                          <div className="flex flex-wrap items-center gap-1.5 gap-y-0">
                            <span className="text-sm font-semibold leading-tight text-foreground">
                              {m.label}
                            </span>
                            <Badge
                              variant="secondary"
                              className="h-5 rounded-md px-1.5 text-[9px] font-medium tabular-nums"
                            >
                              {m.speedBadge}
                            </Badge>
                            {highlightVision && m.supportsVision ? (
                              <Badge
                                variant="outline"
                                className="h-5 rounded-md border-primary/35 bg-primary/8 px-1.5 text-[9px] font-medium text-primary"
                              >
                                Vision
                              </Badge>
                            ) : null}
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                              {contextWindowLabel(m.contextWindow)} context
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                            {m.description}
                          </p>
                        </div>
                        {selected ? (
                          <div className="flex shrink-0 items-start pt-1">
                            <Check
                              className="h-4 w-4 text-primary"
                              strokeWidth={2.5}
                              aria-hidden
                            />
                          </div>
                        ) : (
                          <span className="w-4 shrink-0" aria-hidden />
                        )}
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
