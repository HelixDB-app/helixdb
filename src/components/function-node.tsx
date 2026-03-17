'use client'

import { useEffect, useState } from 'react'
import { Braces, Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

interface FunctionNodeProps {
  data: {
    id: string
    name: string
    language?: string
    returns?: string
    definition?: string
  }
}

export function FunctionNode({ data }: FunctionNodeProps) {
  const { updateFunction, deleteFunction } = useSchemaStore()
  const [name, setName] = useState(data.name)
  const [language, setLanguage] = useState(data.language ?? '')
  const [returns, setReturns] = useState(data.returns ?? '')

  useEffect(() => setName(data.name), [data.name])
  useEffect(() => setLanguage(data.language ?? ''), [data.language])
  useEffect(() => setReturns(data.returns ?? ''), [data.returns])

  const commit = () => {
    const nextName = name.trim() || data.name
    const nextLanguage = language.trim() || undefined
    const nextReturns = returns.trim() || undefined
    let nextDefinition = data.definition
    if (nextDefinition) {
      nextDefinition = nextDefinition
        .replace(
          /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+([^\s(]+)/i,
          (_match, orReplace) =>
            `CREATE ${orReplace ?? ''}FUNCTION ${nextName}`.replace(/\s+/g, ' ').trim()
        )
        .replace(/RETURNS\s+([^\s]+(?:\s+\w+)*)/i, (match) =>
          nextReturns ? `RETURNS ${nextReturns}` : match
        )
        .replace(/LANGUAGE\s+(\w+)/i, (match) =>
          nextLanguage ? `LANGUAGE ${nextLanguage}` : match
        )
    }
    updateFunction(data.id, {
      name: nextName,
      language: nextLanguage,
      returns: nextReturns,
      definition: nextDefinition,
    })
  }

  return (
    <div className="rounded-lg border border-border bg-background shadow-sm min-w-[220px]">
      <div className="flex items-center justify-between border-b border-border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1">
          <Braces className="h-3 w-3" />
          Function
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            deleteFunction(data.id)
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
          placeholder="function_name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
        <div className="flex gap-2">
          <input
            className={cn(
              'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
            )}
            value={language}
            placeholder="plpgsql"
            onChange={(e) => setLanguage(e.target.value)}
            onBlur={commit}
          />
          <input
            className={cn(
              'nodrag h-7 w-full rounded-md border border-border bg-transparent px-2 text-[11px] text-foreground outline-none'
            )}
            value={returns}
            placeholder="returns"
            onChange={(e) => setReturns(e.target.value)}
            onBlur={commit}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Keep logic close to the database for reuse across services.
        </p>
      </div>
    </div>
  )
}
