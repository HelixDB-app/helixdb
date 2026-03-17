'use client'

import { useSchemaStore, Column } from '@/lib/schema-store'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Edit2 } from 'lucide-react'
import { useState } from 'react'

const COLUMN_TYPES = [
  'string',
  'integer',
  'numeric',
  'boolean',
  'text',
  'timestamp',
  'uuid',
  'json',
]

interface TablePropertiesProps {
  tableId: string
  column: Column
}

export function TableProperties({ tableId, column }: TablePropertiesProps) {
  const { updateColumn } = useSchemaStore()
  const [name, setName] = useState(column.name)
  const [type, setType] = useState(column.type)
  const [nullable, setNullable] = useState(column.nullable)
  const [isPrimaryKey, setIsPrimaryKey] = useState(column.isPrimaryKey)
  const [isUnique, setIsUnique] = useState(column.isUnique)
  const [defaultValue, setDefaultValue] = useState(column.default || '')
  const [open, setOpen] = useState(false)

  const handleSave = () => {
    updateColumn(tableId, column.id, {
      name: name || column.name,
      type: (type as any) || column.type,
      nullable,
      isPrimaryKey,
      isUnique,
      default: defaultValue || undefined,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          <Edit2 className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Column</DialogTitle>
          <DialogDescription>
            Modify the column properties below
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Column Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="column_name"
            />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as Column['type'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLUMN_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Default Value</Label>
            <Input
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              placeholder="e.g., 'now()' for timestamp"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pk"
                checked={isPrimaryKey}
                onCheckedChange={(checked) => setIsPrimaryKey(checked as boolean)}
              />
              <label
                htmlFor="pk"
                className="text-sm font-medium cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Primary Key
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="unique"
                checked={isUnique}
                onCheckedChange={(checked) => setIsUnique(checked as boolean)}
                disabled={isPrimaryKey}
              />
              <label
                htmlFor="unique"
                className="text-sm font-medium cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Unique
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="nullable"
                checked={nullable}
                onCheckedChange={(checked) => setNullable(checked as boolean)}
                disabled={isPrimaryKey}
              />
              <label
                htmlFor="nullable"
                className="text-sm font-medium cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Nullable
              </label>
            </div>
          </div>

          <Button onClick={handleSave} className="w-full">
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
