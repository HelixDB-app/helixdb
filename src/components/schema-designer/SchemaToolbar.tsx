'use client'

import { Download, LayoutGrid, Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/schema-designer/ThemeToggle'

export function SchemaToolbar({
  layoutDirection,
  onToggleLayoutDirection,
  onFitView,
  onZoomIn,
  onZoomOut,
  onExportJson,
  onExportPng,
}: {
  layoutDirection: 'LR' | 'TB'
  onToggleLayoutDirection: () => void
  onFitView: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onExportJson: () => void
  onExportPng: () => void
}) {
  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[#111111]/90 px-3 py-2 shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur-xl">
      <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onFitView}>
        <Maximize2 className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onZoomIn}>
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onZoomOut}>
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button variant="ghost" className="h-9 rounded-full px-3 text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onToggleLayoutDirection}>
        <LayoutGrid className="mr-2 h-4 w-4" />
        {layoutDirection}
      </Button>
      <Button variant="ghost" className="h-9 rounded-full px-3 text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onExportJson}>
        <Download className="mr-2 h-4 w-4" />
        JSON
      </Button>
      <Button variant="ghost" className="h-9 rounded-full px-3 text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onExportPng}>
        <Minimize2 className="mr-2 h-4 w-4" />
        PNG
      </Button>
      <ThemeToggle />
    </div>
  )
}
