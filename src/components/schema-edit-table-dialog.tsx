'use client'

import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { MonacoSqlEditor } from '@/components/monaco-sql-editor'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createSchemaColumnId } from '@/lib/schema-canvas-layout'
import { generateSQL } from '@/lib/sql-export'
import { useSchemaStore } from '@/lib/schema-store'
import type { Column } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

const TYPES = [
  'string',
  'integer',
  'numeric',
  'boolean',
  'text',
  'timestamp',
  'uuid',
  'json',
] as const

export function SchemaEditTableDialog() {
  const designerEditTableId = useSchemaStore((s) => s.designerEditTableId)
  const setDesignerEditTableId = useSchemaStore((s) => s.setDesignerEditTableId)
  const tables = useSchemaStore((s) => s.tables)
  const relationships = useSchemaStore((s) => s.relationships)
  const functions = useSchemaStore((s) => s.functions)
  const triggers = useSchemaStore((s) => s.triggers)
  const updateTable = useSchemaStore((s) => s.updateTable)
  const addColumn = useSchemaStore((s) => s.addColumn)
  const updateColumn = useSchemaStore((s) => s.updateColumn)
  const deleteColumn = useSchemaStore((s) => s.deleteColumn)
  const deleteTable = useSchemaStore((s) => s.deleteTable)

  const table = useMemo(
    () => tables.find((t) => t.id === designerEditTableId) ?? null,
    [tables, designerEditTableId]
  )

  const ddlPreview = useMemo(() => {
    if (!table) return ''
    try {
      return generateSQL([table], relationships, functions, triggers)
    } catch {
      return '-- (unable to generate)'
    }
  }, [table, relationships, functions, triggers])

  return (
    <Dialog
      open={Boolean(designerEditTableId && table)}
      onOpenChange={(o) => {
        if (!o) setDesignerEditTableId(null)
      }}
    >
      <DialogContent
        key={table?.id}
        className="max-h-[min(90vh,820px)] overflow-hidden sm:max-w-[640px]"
      >
        {table ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit table</DialogTitle>
              <DialogDescription>
                Adjust columns and metadata. SQL preview reflects the full schema.
              </DialogDescription>
            </DialogHeader>
            <Tabs defaultValue="fields" className="min-h-0 flex-1">
              <TabsList className="w-full">
                <TabsTrigger value="fields" className="flex-1">
                  Fields
                </TabsTrigger>
                <TabsTrigger value="sql" className="flex-1">
                  SQL preview
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="fields"
                className="mt-3 max-h-[min(60vh,520px)] space-y-4 overflow-y-auto pr-1"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Table name</Label>
                    <Input
                      value={table.name}
                      onChange={(e) =>
                        updateTable(table.id, { name: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label>Accent (hex)</Label>
                    <Input
                      value={table.hexColor ?? '#6366f1'}
                      onChange={(e) =>
                        updateTable(table.id, { hexColor: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div>
                  <Label>Description</Label>
                  <Input
                    value={table.description ?? ''}
                    onChange={(e) =>
                      updateTable(table.id, { description: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Columns</Label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1"
                      onClick={() =>
                        addColumn(table.id, {
                          id: createSchemaColumnId(),
                          name: `col_${table.columns.length + 1}`,
                          type: 'string',
                          nullable: true,
                          isPrimaryKey: false,
                          isUnique: false,
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </Button>
                  </div>
                  <ul className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-2">
                    {table.columns.map((col) => (
                      <li
                        key={col.id}
                        className="grid gap-2 rounded-md border border-border/40 bg-background/80 p-2 sm:grid-cols-[1fr_100px_auto]"
                      >
                        <Input
                          value={col.name}
                          onChange={(e) =>
                            updateColumn(table.id, col.id, { name: e.target.value })
                          }
                        />
                        <select
                          className={cn(
                            'h-9 rounded-md border border-input bg-background px-2 text-xs'
                          )}
                          value={col.type}
                          onChange={(e) =>
                            updateColumn(table.id, col.id, {
                              type: e.target.value as Column['type'],
                            })
                          }
                        >
                          {TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={col.isPrimaryKey}
                              onChange={(e) =>
                                updateColumn(table.id, col.id, {
                                  isPrimaryKey: e.target.checked,
                                })
                              }
                            />
                            PK
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            onClick={() => deleteColumn(table.id, col.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </TabsContent>
              <TabsContent value="sql" className="mt-3 h-[min(50vh,380px)] min-h-[200px]">
                <MonacoSqlEditor
                  value={ddlPreview}
                  onChange={() => {}}
                  onExecute={() => {}}
                  className="h-full rounded-md border border-border/60"
                  fillHeight
                  hideNextActionSuggestions
                  disabled
                />
              </TabsContent>
            </Tabs>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  deleteTable(table.id)
                  setDesignerEditTableId(null)
                }}
              >
                Delete table
              </Button>
              <Button type="button" onClick={() => setDesignerEditTableId(null)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
