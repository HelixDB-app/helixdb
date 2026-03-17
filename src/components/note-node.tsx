'use client'

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

interface NoteNodeProps {
  data: {
    id: string
    text?: string
  }
}

export function NoteNode({ data }: NoteNodeProps) {
  const { updateCanvasItem, deleteCanvasItem } = useSchemaStore()
  const [text, setText] = useState(data.text ?? '')

  useEffect(() => {
    setText(data.text ?? '')
  }, [data.text])

  return (
    <div className="rounded-lg border border-border bg-background shadow-sm min-w-[220px]">
      <div className="flex items-center justify-between border-b border-border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
        Note
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
      <textarea
        className={cn(
          'nodrag w-full resize-none bg-transparent p-2 text-xs text-foreground outline-none'
        )}
        placeholder="Add your notes..."
        value={text}
        rows={6}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          updateCanvasItem(data.id, { text: next })
        }}
      />
    </div>
  )
}
