'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { Copy, Download, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  exportFormatExtension,
  exportFormatFileStem,
  generateExport,
  EXPORT_FORMAT_LABEL,
  type ExportFormat,
} from '@/codegen/index'
import type { Table } from '@/lib/schema-store'
import { callGeminiSync, type GeminiModelId } from '@/lib/ai-chat-engine'
import { withGeminiLogging } from '@/lib/gemini-logger'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  resolveGeminiApiKey,
  useSettingsStore,
} from '@/stores/settings-store'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
})

const FORMATS: ExportFormat[] = [
  'typescript',
  'prisma',
  'drizzle',
  'zod',
  'graphql',
  'pydantic',
]

function monacoLanguage(format: ExportFormat): string {
  switch (format) {
    case 'prisma':
      return 'plaintext'
    case 'graphql':
      return 'graphql'
    case 'pydantic':
      return 'python'
    default:
      return 'typescript'
  }
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const JSDOC_SYSTEM = `You document PostgreSQL-backed TypeScript types for pgStudio.

RULES:
1. Output TypeScript ONLY — no markdown fences, no commentary before or after code.
2. Preserve every export, interface name, type name, field name, and TypeScript type exactly.
3. Add a JSDoc block /** ... */ immediately above each interface property and above each type alias member line where applicable. One concise sentence per field, inferred from the field name (e.g. user email, created timestamp).
4. Keep the same file structure: export interface ... and export type ...CreateInput blocks.
5. Do not remove or rename anything.`

export interface TypeExporterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tables: Table[]
}

export function TypeExporter({
  open,
  onOpenChange,
  tables,
}: TypeExporterProps) {
  const { resolvedTheme } = useTheme()
  const [format, setFormat] = useState<ExportFormat>('typescript')
  const [editedText, setEditedText] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)

  const generated = useMemo(
    () => generateExport(tables, format),
    [tables, format]
  )

  const display = editedText ?? generated

  useEffect(() => {
    setEditedText(null)
  }, [format, tables])

  const monacoTheme = resolvedTheme === 'dark' ? 'vs-dark' : 'light'

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(display)
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Could not copy')
    }
  }, [display])

  const handleDownload = useCallback(() => {
    const stem = exportFormatFileStem(format)
    const ext = exportFormatExtension(format)
    const mime =
      ext === 'py'
        ? 'text/x-python'
        : ext === 'prisma' || ext === 'graphql'
          ? 'text/plain'
          : 'text/typescript'
    downloadBlob(display, `${stem}.${ext}`, mime)
  }, [display, format])

  const addJsdoc = useCallback(async () => {
    if (format !== 'typescript') return
    const settings = useSettingsStore.getState()
    const apiKey = resolveGeminiApiKey(settings.geminiApiKey)
    if (!apiKey?.trim()) {
      toast.error('Add a Gemini API key in Settings.')
      return
    }
    const model = (settings.defaultAiModel ??
      'gemini-2.5-flash') as GeminiModelId
    const payload = display.trim()
    if (!payload) return
    setAiBusy(true)
    try {
      const raw = await withGeminiLogging(
        async () =>
          callGeminiSync(
            model,
            apiKey,
            [{ role: 'user', parts: [{ text: payload }] }],
            JSDOC_SYSTEM,
            undefined,
            { maxOutputTokens: 8192 }
          ),
        {
          model,
          featureType: 'type-export-jsdoc',
          endpoint: 'generateContent',
        }
      )
      const next = raw.trim()
      if (!next.includes('export ')) {
        toast.error('Model did not return valid TypeScript.')
        return
      }
      setEditedText(next)
      toast.success('JSDoc added')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setAiBusy(false)
    }
  }, [display, format])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl gap-4 overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Export types</DialogTitle>
          <DialogDescription>
            CreateInput variants omit primary keys and timestamp columns. Switch
            format, then copy or download.
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex shrink-0 flex-wrap gap-1 rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="Export format"
        >
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={format === f}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:text-sm',
                format === f
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setFormat(f)}
            >
              {EXPORT_FORMAT_LABEL[f]}
            </button>
          ))}
        </div>

        <div className="min-h-[320px] flex-1 overflow-hidden rounded-lg border border-border">
          <MonacoEditor
            key={`${format}-${tables.length}`}
            height="400px"
            language={monacoLanguage(format)}
            theme={monacoTheme}
            path={`pgstudio-export.${exportFormatExtension(format)}`}
            value={display}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 12, bottom: 12 },
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="gap-1.5"
            onClick={() => void handleCopy()}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="gap-1.5"
            onClick={handleDownload}
          >
            <Download className="h-3.5 w-3.5" />
            Download .{exportFormatExtension(format)}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={format !== 'typescript' || aiBusy || !display.trim()}
            onClick={() => void addJsdoc()}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {aiBusy ? 'Annotating…' : 'AI: Add JSDoc'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
