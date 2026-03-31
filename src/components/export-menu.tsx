'use client'

import { useState } from 'react'
import { Braces, Download } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { TypeExporter } from '@/components/export/TypeExporter'
import { generateSQL, generateTypeScript, generateJSON } from '@/lib/sql-export'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function ExportMenu() {
  const { tables, relationships, functions, triggers, canvasItems } =
    useSchemaStore()
  const [typeExporterOpen, setTypeExporterOpen] = useState(false)

  const handleExportSQL = () => {
    const sql = generateSQL(tables, relationships, functions, triggers)
    downloadFile(sql, 'schema.sql', 'text/sql')
  }

  const handleExportTypeScript = () => {
    const ts = generateTypeScript(tables)
    downloadFile(ts, 'schema.ts', 'text/typescript')
  }

  const handleExportJSON = () => {
    const json = generateJSON(tables, relationships, functions, triggers, canvasItems)
    downloadFile(json, 'schema.json', 'application/json')
  }

  const handleCopySQL = async () => {
    const sql = generateSQL(tables, relationships, functions, triggers)
    await navigator.clipboard.writeText(sql)
  }

  const handleCopyTypeScript = async () => {
    const ts = generateTypeScript(tables)
    await navigator.clipboard.writeText(ts)
  }

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-4 w-4" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Download</DropdownMenuLabel>
        <DropdownMenuItem onClick={handleExportSQL}>
          SQL Schema (.sql)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleExportTypeScript}>
          TypeScript Types (.ts)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleExportJSON}>
          JSON Schema (.json)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Copy to Clipboard</DropdownMenuLabel>
        <DropdownMenuItem onClick={handleCopySQL}>
          Copy SQL
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyTypeScript}>
          Copy TypeScript
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setTypeExporterOpen(true)}
          className="gap-2"
        >
          <Braces className="h-4 w-4" />
          Type exporter…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <TypeExporter
      open={typeExporterOpen}
      onOpenChange={setTypeExporterOpen}
      tables={tables}
    />
    </>
  )
}
