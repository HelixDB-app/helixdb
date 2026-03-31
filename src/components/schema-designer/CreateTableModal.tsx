'use client'

import { useCallback, useState } from 'react'
import { PaintBucket, Plus } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { TABLE_COLORS } from '@/lib/schema-designer/constants'
import type { TableSchema } from '@/lib/schema-designer/types'

function buildTable(name: string, description: string, color: string): TableSchema {
  return {
    id: uuidv4(),
    name,
    description,
    color,
    columns: [
      {
        id: uuidv4(),
        name: 'id',
        type: 'uuid',
        nullable: false,
        primaryKey: true,
        unique: true,
        default: 'gen_random_uuid()',
        references: null,
        description: 'Primary identifier',
      },
    ],
    indexes: [],
    position: null,
  }
}

export function CreateTableModal({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (table: TableSchema) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string>(TABLE_COLORS[0])

  const reset = useCallback(() => {
    setName('')
    setDescription('')
    setColor(TABLE_COLORS[0])
  }, [])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl rounded-[28px] border-white/10 bg-[#141414] text-white">
        <DialogHeader>
          <DialogTitle className="text-xl">Create table</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-table-name" className="text-zinc-300">Table name</Label>
            <Input
              id="new-table-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="orders"
              className="h-11 rounded-2xl border-white/10 bg-white/5 text-white"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-table-description" className="text-zinc-300">Description</Label>
            <Textarea
              id="new-table-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Tracks customer orders and fulfillment status."
              className="min-h-[120px] rounded-2xl border-white/10 bg-white/5 text-white"
            />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-zinc-300">
              <PaintBucket className="h-4 w-4" />
              Accent color
            </Label>
            <div className="flex flex-wrap gap-2">
              {TABLE_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  className={`h-9 w-9 rounded-full border ${color === swatch ? 'border-white' : 'border-white/10'}`}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} className="rounded-2xl text-zinc-300">
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!name.trim()) return
              onCreate(buildTable(name.trim(), description.trim(), color))
              handleOpenChange(false)
            }}
            className="rounded-2xl bg-white text-black hover:bg-zinc-200"
          >
            <Plus className="mr-2 h-4 w-4" />
            Create table
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
