'use client'

import { useState } from 'react'
import { useSchemaStore } from '@/lib/schema-store'
import { defaultTablePosition } from '@/lib/schema-canvas-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface AddTableDialogProps {
  trigger?: React.ReactNode
}

export function AddTableDialog({ trigger }: AddTableDialogProps) {
  const { tables, addTable } = useSchemaStore()
  const [open, setOpen] = useState(false)
  const [tableName, setTableName] = useState('')

  const handleAdd = () => {
    if (!tableName.trim()) return

    const { x, y } = defaultTablePosition(tables.length)
    addTable({
      id: `table-${Date.now()}`,
      name: tableName,
      x,
      y,
      indexes: [],
      columns: [
        {
          id: `col-${Date.now()}`,
          name: 'id',
          type: 'uuid',
          nullable: false,
          isPrimaryKey: true,
          isUnique: true,
        },
      ],
    })

    setTableName('')
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || <Button variant="default">Add Table</Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Table</DialogTitle>
          <DialogDescription>
            Add a new table to your database schema. An ID column will be created automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tableName">Table Name</Label>
            <Input
              id="tableName"
              placeholder="e.g., users, products, orders"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd()
              }}
            />
          </div>
          <Button onClick={handleAdd} className="w-full">
            Create Table
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
