'use client'

import { useEffect, useState } from 'react'
import { Image, Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

interface ImageNodeProps {
  data: {
    id: string
    imageUrl?: string
    text?: string
  }
}

export function ImageNode({ data }: ImageNodeProps) {
  const { updateCanvasItem, deleteCanvasItem } = useSchemaStore()
  const [url, setUrl] = useState(data.imageUrl ?? '')
  const [caption, setCaption] = useState(data.text ?? '')

  useEffect(() => {
    setUrl(data.imageUrl ?? '')
  }, [data.imageUrl])

  useEffect(() => {
    setCaption(data.text ?? '')
  }, [data.text])

  return (
    <div className="rounded-lg border border-border bg-background shadow-sm min-w-[220px]">
      <div className="flex items-center justify-between border-b border-border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1">
          <Image className="h-3 w-3" />
          Image
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
      <div className="p-2 space-y-2">
        {url ? (
          <img
            src={url}
            alt={caption || 'Canvas image'}
            className="h-28 w-full rounded-md object-cover border border-border"
          />
        ) : (
          <div className="h-28 w-full rounded-md border border-dashed border-border flex items-center justify-center text-[10px] text-muted-foreground">
            Paste an image URL below
          </div>
        )}
        <input
          className={cn(
            'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
          )}
          placeholder="https://..."
          value={url}
          onChange={(e) => {
            const next = e.target.value
            setUrl(next)
            updateCanvasItem(data.id, { imageUrl: next })
          }}
        />
        <input
          className={cn(
            'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
          )}
          placeholder="Caption"
          value={caption}
          onChange={(e) => {
            const next = e.target.value
            setCaption(next)
            updateCanvasItem(data.id, { text: next })
          }}
        />
      </div>
    </div>
  )
}
