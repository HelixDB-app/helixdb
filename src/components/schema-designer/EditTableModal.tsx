'use client'

import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { TableSchema } from '@/lib/schema-designer/types'

const DATA_TYPES = [
  'uuid',
  'text',
  'varchar(255)',
  'integer',
  'numeric',
  'boolean',
  'jsonb',
  'timestamp',
  'date',
]

export function EditTableModal({
  open,
  onOpenChange,
  table,
  allTables,
  onSave,
  onDelete,
  onAskAiModify,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  table: TableSchema | null
  allTables: TableSchema[]
  onSave: (updated: TableSchema) => void
  onDelete: () => void
  onAskAiModify?: (prompt: string) => void
}) {
  if (!table) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <EditTableModalBody
        key={table.id}
        table={table}
        allTables={allTables}
        onSave={onSave}
        onDelete={onDelete}
        onCancel={() => onOpenChange(false)}
        onAskAiModify={onAskAiModify}
      />
    </Dialog>
  )
}

function EditTableModalBody({
  table,
  allTables,
  onSave,
  onDelete,
  onCancel,
  onAskAiModify,
}: {
  table: TableSchema
  allTables: TableSchema[]
  onSave: (updated: TableSchema) => void
  onDelete: () => void
  onCancel: () => void
  onAskAiModify?: (prompt: string) => void
}) {
  const [draft, setDraft] = useState<TableSchema>(table)
  const [aiPrompt, setAiPrompt] = useState('')

  const tableOptions = useMemo(
    () => allTables.filter((candidate) => candidate.id !== draft.id),
    [allTables, draft.id]
  )

  return (
    <DialogContent className="max-h-[88vh] max-w-4xl overflow-hidden rounded-[28px] border-white/10 bg-[#141414] text-white">
      <DialogHeader>
        <DialogTitle className="text-xl">Edit table</DialogTitle>
      </DialogHeader>
      <div className="grid gap-5 overflow-y-auto pr-2 xl:grid-cols-[0.85fr_1.15fr]">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-table-name" className="text-zinc-300">Table name</Label>
            <Input
              id="edit-table-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="h-11 rounded-2xl border-white/10 bg-white/5 text-white"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-table-description" className="text-zinc-300">Description</Label>
            <Textarea
              id="edit-table-description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              className="min-h-[120px] rounded-2xl border-white/10 bg-white/5 text-white"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-table-color" className="text-zinc-300">Accent color</Label>
            <Input
              id="edit-table-color"
              value={draft.color}
              onChange={(event) => setDraft({ ...draft, color: event.target.value })}
              className="h-11 rounded-2xl border-white/10 bg-white/5 text-white"
            />
          </div>
          <div className="space-y-2 rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
            <Label className="text-zinc-300">Ask AI to modify this table</Label>
            <Textarea
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder="e.g. add soft delete support and an index for customer lookups"
              className="min-h-[110px] rounded-2xl border-white/10 bg-white/5 text-white"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={!aiPrompt.trim() || !onAskAiModify}
              onClick={() => {
                onAskAiModify?.(aiPrompt.trim())
                setAiPrompt('')
              }}
              className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10"
            >
              Ask AI to modify
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-white">Columns</p>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setDraft({
                  ...draft,
                  columns: [
                    ...draft.columns,
                    {
                      id: uuidv4(),
                      name: `column_${draft.columns.length + 1}`,
                      type: 'text',
                      nullable: true,
                      primaryKey: false,
                      unique: false,
                      default: null,
                      references: null,
                      description: '',
                    },
                  ],
                })
              }
              className="rounded-2xl text-zinc-300"
            >
              Add column
            </Button>
          </div>

          <div className="space-y-3">
            {draft.columns.map((column) => (
              <div key={column.id} className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                <div className="grid gap-3 lg:grid-cols-[1.15fr_0.95fr]">
                  <Input
                    value={column.name}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        columns: draft.columns.map((entry) =>
                          entry.id === column.id ? { ...entry, name: event.target.value } : entry
                        ),
                      })
                    }
                    className="h-10 rounded-2xl border-white/10 bg-white/5 text-white"
                  />
                  <Select
                    value={column.type}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        columns: draft.columns.map((entry) =>
                          entry.id === column.id ? { ...entry, type: value } : entry
                        ),
                      })
                    }
                  >
                    <SelectTrigger className="h-10 rounded-2xl border-white/10 bg-white/5 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
                      {DATA_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>{type}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {[
                    ['nullable', 'Nullable'],
                    ['primaryKey', 'Primary key'],
                    ['unique', 'Unique'],
                  ].map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-zinc-300">
                      <span>{label}</span>
                      <Switch
                        checked={Boolean(column[key as keyof typeof column])}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            columns: draft.columns.map((entry) =>
                              entry.id === column.id ? { ...entry, [key]: checked } : entry
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    className="justify-start rounded-2xl border border-transparent px-3 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        columns: draft.columns.filter((entry) => entry.id !== column.id),
                      })
                    }
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </Button>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <Input
                    value={column.default ?? ''}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        columns: draft.columns.map((entry) =>
                          entry.id === column.id
                            ? { ...entry, default: event.target.value || null }
                            : entry
                        ),
                      })
                    }
                    placeholder="Default value"
                    className="h-10 rounded-2xl border-white/10 bg-white/5 text-white"
                  />
                  <Select
                    value={column.references?.table ?? '__none__'}
                    onValueChange={(value) => {
                      const targetTable = tableOptions.find((entry) => entry.name === value)
                      setDraft({
                        ...draft,
                        columns: draft.columns.map((entry) =>
                          entry.id === column.id
                            ? {
                                ...entry,
                                references:
                                  value === '__none__' || !targetTable
                                    ? null
                                    : {
                                        table: targetTable.name,
                                        column: targetTable.columns[0]?.name ?? 'id',
                                        onDelete: 'CASCADE',
                                        onUpdate: 'CASCADE',
                                      },
                              }
                            : entry
                        ),
                      })
                    }}
                  >
                    <SelectTrigger className="h-10 rounded-2xl border-white/10 bg-white/5 text-white">
                      <SelectValue placeholder="FK reference" />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
                      <SelectItem value="__none__">No foreign key</SelectItem>
                      {tableOptions.map((entry) => (
                        <SelectItem key={entry.id} value={entry.name}>{entry.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDelete} className="mr-auto rounded-2xl text-rose-300 hover:bg-rose-500/10 hover:text-rose-200">
          <Trash2 className="mr-2 h-4 w-4" />
          Delete table
        </Button>
        <Button variant="ghost" onClick={onCancel} className="rounded-2xl text-zinc-300">
          Cancel
        </Button>
        <Button onClick={() => onSave(draft)} className="rounded-2xl bg-white text-black hover:bg-zinc-200">
          Save changes
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
