'use client'

import { useEffect, useState } from 'react'
import { Zap, Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

interface TriggerNodeProps {
  data: {
    id: string
    name: string
    tableName?: string
    functionName: string
    timing?: string
    events?: string[]
  }
}

export function TriggerNode({ data }: TriggerNodeProps) {
  const { updateTrigger, deleteTrigger } = useSchemaStore()
  const [name, setName] = useState(data.name)
  const [functionName, setFunctionName] = useState(data.functionName)
  const [timing, setTiming] = useState(data.timing ?? 'AFTER')
  const [events, setEvents] = useState((data.events ?? []).join(', '))

  useEffect(() => setName(data.name), [data.name])
  useEffect(() => setFunctionName(data.functionName), [data.functionName])
  useEffect(() => setTiming(data.timing ?? 'AFTER'), [data.timing])
  useEffect(() => setEvents((data.events ?? []).join(', ')), [data.events])

  const commit = () => {
    updateTrigger(data.id, {
      name: name.trim() || data.name,
      functionName: functionName.trim() || data.functionName,
      timing: timing.trim() || undefined,
      events: events
        .split(',')
        .map((e) => e.trim().toUpperCase())
        .filter(Boolean),
    })
  }

  return (
    <div className="rounded-lg border border-border bg-background shadow-sm min-w-[230px]">
      <div className="flex items-center justify-between border-b border-border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3" />
          Trigger
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            deleteTrigger(data.id)
          }}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div className="p-2 space-y-2 text-[11px]">
        <input
          className={cn(
            'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
          )}
          value={name}
          placeholder="trigger_name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
        />
        <div className="flex gap-2">
          <input
            className={cn(
              'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
            )}
            value={timing}
            placeholder="BEFORE / AFTER"
            onChange={(e) => setTiming(e.target.value)}
            onBlur={commit}
          />
          <input
            className={cn(
              'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
            )}
            value={events}
            placeholder="INSERT, UPDATE"
            onChange={(e) => setEvents(e.target.value)}
            onBlur={commit}
          />
        </div>
        <input
          className={cn(
            'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
          )}
          value={functionName}
          placeholder="function_name"
          onChange={(e) => setFunctionName(e.target.value)}
          onBlur={commit}
        />
        <p className="text-[10px] text-muted-foreground">
          {data.tableName ? `Runs on ${data.tableName}` : 'Runs on table'}
        </p>
      </div>
    </div>
  )
}
