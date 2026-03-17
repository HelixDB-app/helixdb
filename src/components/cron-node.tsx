'use client'

import { useEffect, useState } from 'react'
import { AlarmClock, Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

interface CronNodeProps {
  data: {
    id: string
    schedule?: string
    task?: string
  }
}

export function CronNode({ data }: CronNodeProps) {
  const { updateCanvasItem, deleteCanvasItem } = useSchemaStore()
  const [schedule, setSchedule] = useState(data.schedule ?? '')
  const [task, setTask] = useState(data.task ?? '')

  useEffect(() => {
    setSchedule(data.schedule ?? '')
  }, [data.schedule])

  useEffect(() => {
    setTask(data.task ?? '')
  }, [data.task])

  return (
    <div className="rounded-lg border border-border bg-background shadow-sm min-w-[220px]">
      <div className="flex items-center justify-between border-b border-border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1">
          <AlarmClock className="h-3 w-3" />
          Cron Job
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            deleteCanvasItem(data.id)
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
          placeholder="*/5 * * * *"
          value={schedule}
          onChange={(e) => {
            const next = e.target.value
            setSchedule(next)
            updateCanvasItem(data.id, { schedule: next })
          }}
        />
        <input
          className={cn(
            'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
          )}
          placeholder="Task description"
          value={task}
          onChange={(e) => {
            const next = e.target.value
            setTask(next)
            updateCanvasItem(data.id, { task: next })
          }}
        />
        <p className="text-[10px] text-muted-foreground">
          Define scheduled jobs like nightly syncs or cleanup scripts.
        </p>
      </div>
    </div>
  )
}
