'use client'

import { HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'

const shortcuts = [
  {
    keys: ['Delete'],
    description: 'Remove selected table or relationship',
  },
  {
    keys: ['Escape'],
    description: 'Deselect current element',
  },
  {
    keys: ['Drag'],
    description: 'Move tables on canvas',
  },
  {
    keys: ['Click'],
    description: 'Select table or view properties',
  },
  {
    keys: ['Scroll'],
    description: 'Zoom in/out on canvas',
  },
  {
    keys: ['Ctrl/Cmd', 'Export'],
    description: 'Download schema in multiple formats',
  },
]

export function KeyboardHelp() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <HelpCircle className="h-4 w-4" />
          Help
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Learn how to use the Schema Designer
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold mb-3">Canvas Controls</h3>
            <div className="space-y-2">
              {shortcuts.map((shortcut, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">
                    {shortcut.description}
                  </span>
                  <div className="flex gap-1 ml-2">
                    {shortcut.keys.map((key, i) => (
                      <span key={i}>
                        <Kbd className="text-xs">{key}</Kbd>
                        {i < shortcut.keys.length - 1 && (
                          <span className="mx-1 text-muted-foreground">+</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4 border-t border-border">
            <h3 className="text-sm font-semibold mb-3">Tips</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>• Click the + button in the schema to add new tables</li>
              <li>• Hover over columns to edit or delete them</li>
              <li>• Drag table handles to create relationships</li>
              <li>• All changes are auto-saved to your browser</li>
              <li>• Export in SQL, TypeScript, or JSON formats</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
