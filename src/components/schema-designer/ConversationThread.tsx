'use client'

import { useState } from 'react'
import { ArrowUpRight, MessageSquareText, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { CONTINUATION_SUGGESTIONS } from '@/lib/schema-designer/constants'
import type { ConversationMessage } from '@/lib/schema-designer/types'

function roleLabel(role: ConversationMessage['role']) {
  if (role === 'assistant') return 'AI'
  if (role === 'system') return 'System'
  return 'You'
}

export function ConversationThread({
  messages,
  submitting,
  onContinue,
}: {
  messages: ConversationMessage[]
  submitting?: boolean
  onContinue: (prompt: string) => Promise<void> | void
}) {
  const [value, setValue] = useState('')

  return (
    <div className="flex h-full flex-col rounded-[30px] border border-white/8 bg-[#111111]/88 p-4 shadow-[0_24px_70px_rgba(0,0,0,0.36)] backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Conversation</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Schema evolution thread</h2>
        </div>
        <Badge className="rounded-full border-white/10 bg-white/5 text-zinc-300">
          <MessageSquareText className="mr-1 h-3 w-3" />
          {messages.length} messages
        </Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1 pr-2">
        <div className="space-y-3">
          {messages.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm leading-7 text-zinc-400">
              The assistant conversation will land here after the first schema generation.
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/6 text-xs font-semibold text-white">
                      {roleLabel(message.role).slice(0, 1)}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-white">{roleLabel(message.role)}</p>
                      <p className="text-[11px] text-zinc-500">{new Date(message.timestamp).toLocaleString()}</p>
                    </div>
                  </div>
                  {message.model ? (
                    <Badge className="rounded-full border-white/10 bg-white/5 text-[10px] text-zinc-400">
                      {message.model}
                    </Badge>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">
                  {message.content}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <div className="mt-4 space-y-3 rounded-[24px] border border-white/10 bg-black/20 p-4">
        <div className="flex flex-wrap gap-2">
          {CONTINUATION_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setValue(suggestion)}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
            >
              {suggestion}
            </button>
          ))}
        </div>
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Continue this conversation… e.g. add audit logging and optimize for a read-heavy analytics dashboard."
          className="min-h-[120px] rounded-[24px] border-white/10 bg-white/5 text-white placeholder:text-zinc-500"
        />
        <Button
          type="button"
          disabled={submitting || !value.trim()}
          onClick={async () => {
            await onContinue(value)
            setValue('')
          }}
          className="h-11 w-full rounded-2xl bg-white text-black hover:bg-zinc-200"
        >
          <Sparkles className="mr-2 h-4 w-4" />
          {submitting ? 'Applying changes…' : 'Continue conversation'}
          <ArrowUpRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
