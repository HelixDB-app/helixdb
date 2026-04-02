'use client'

import { memo, useCallback, type ReactNode } from 'react'
import { Cloud, CloudOff, Loader2 } from 'lucide-react'
import {
  AlarmClock,
  Frame,
  Hand,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  MousePointer2,
  Network,
  Pencil,
  Palette,
  Search,
  Sparkles,
  SquareDashed,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LayoutCluster } from '@/canvas/clustering'

export type CanvasTool = 'select' | 'pan' | 'marquee'

type ToolbarTable = { id: string; name: string }

const toolBtnBase =
  'nodrag nopan flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-transparent transition-[background,box-shadow,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

const ToolbarBtn = memo(function ToolbarBtn({
  label,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          aria-pressed={active ?? false}
          onClick={onClick}
          className={cn(
            toolBtnBase,
            active
              ? 'border-border/50 bg-primary text-primary-foreground shadow-md'
              : 'text-muted-foreground hover:bg-muted/90 hover:text-foreground',
            disabled && 'pointer-events-none opacity-40'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  )
})

type Props = {
  canvasTool: CanvasTool
  setCanvasTool: (t: CanvasTool) => void
  sortedTables: ToolbarTable[]
  onJumpToTable: (id: string) => void
  jumpOpen: boolean
  setJumpOpen: (v: boolean) => void
  onAddNote: () => void
  onAddImage: () => void
  onAddCron: () => void
  onAddTable: () => void
  onAlign: () => void
  dagreRankDir: 'TB' | 'LR'
  onDagreDirChange: (dir: 'TB' | 'LR') => void
  onDagreLayout: () => void
  clusterMode: 'heuristic' | 'gemini'
  onClusterModeChange: (m: 'heuristic' | 'gemini') => void
  clusterGrouped: boolean
  clusterLayoutBusy: boolean
  tablesLength: number
  onClusterToggle: () => void
  onUngroupClusters: () => void
  relEdgeSmooth: boolean
  onRelEdgeSmoothChange: (v: boolean) => void
  onFitView: () => void
  inspector?: ReactNode
  clustersPanel?: ReactNode
  /** Cloud sync status chip (React Flow toolbar) */
  cloudSyncSlot?: ReactNode
}

export type SchemaCloudSyncDisplayProps = {
  status:
    | 'disabled'
    | 'idle'
    | 'connecting'
    | 'synced'
    | 'saving'
    | 'pending_offline'
    | 'error'
  onRetry?: () => void
  title?: string
}

export const SchemaCloudSyncChip = memo(function SchemaCloudSyncChip({
  status,
  onRetry,
  title,
}: SchemaCloudSyncDisplayProps) {
  if (status === 'disabled') return null
  const label =
    status === 'synced'
      ? 'Synced'
      : status === 'saving'
        ? 'Saving…'
        : status === 'connecting'
          ? 'Connecting…'
          : status === 'pending_offline'
            ? 'Pending'
            : status === 'error'
              ? 'Sync issue'
              : 'Cloud'
  const colorClass =
    status === 'synced'
      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : status === 'saving' || status === 'connecting'
        ? 'border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-200'
        : status === 'pending_offline' || status === 'error'
          ? 'border-red-500/40 bg-red-500/12 text-red-800 dark:text-red-200'
          : 'border-border/50 bg-muted/40 text-muted-foreground'
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={status === 'error' ? onRetry : undefined}
          disabled={status !== 'error' || !onRetry}
          title={title}
          className={cn(
            'nodrag nopan pointer-events-auto flex max-w-[140px] items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide shadow-sm backdrop-blur-sm',
            colorClass
          )}
        >
          {status === 'saving' || status === 'connecting' ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : status === 'pending_offline' || status === 'error' ? (
            <CloudOff className="h-3 w-3 shrink-0" />
          ) : status === 'synced' ? (
            <Cloud className="h-3 w-3 shrink-0" />
          ) : (
            <Cloud className="h-3 w-3 shrink-0 opacity-60" />
          )}
          <span className="truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[220px] text-xs">
        {title ?? label}
      </TooltipContent>
    </Tooltip>
  )
})

export const SchemaFlowCanvasToolbar = memo(function SchemaFlowCanvasToolbar({
  canvasTool,
  setCanvasTool,
  sortedTables,
  onJumpToTable,
  jumpOpen,
  setJumpOpen,
  onAddNote,
  onAddImage,
  onAddCron,
  onAddTable,
  onAlign,
  dagreRankDir,
  onDagreDirChange,
  onDagreLayout,
  clusterMode,
  onClusterModeChange,
  clusterGrouped,
  clusterLayoutBusy,
  tablesLength,
  onClusterToggle,
  onUngroupClusters,
  relEdgeSmooth,
  onRelEdgeSmoothChange,
  onFitView,
  inspector,
  clustersPanel,
  cloudSyncSlot,
}: Props) {
  const stop = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])

  return (
    <div
      className="pointer-events-none absolute right-3 top-3 z-20 flex max-h-[min(calc(100vh-6rem),760px)] flex-col items-end gap-2"
      onPointerDown={stop}
    >
      <div
        role="toolbar"
        aria-label="Canvas tools"
        className="pointer-events-auto flex flex-col items-center gap-0.5 rounded-full border border-border/60 bg-card/88 py-2 pl-1.5 pr-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl dark:bg-card/80 dark:shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
      >
        {cloudSyncSlot ? (
          <div className="mb-1 flex w-full justify-center px-0.5">{cloudSyncSlot}</div>
        ) : null}
        <ToolbarBtn
          label="Select and move nodes"
          active={canvasTool === 'select'}
          onClick={() => setCanvasTool('select')}
        >
          <MousePointer2 className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn
          label="Marquee selection"
          active={canvasTool === 'marquee'}
          onClick={() => setCanvasTool('marquee')}
        >
          <SquareDashed className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn
          label="Add sticky note"
          onClick={onAddNote}
        >
          <Pencil className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn
          label="Pan canvas"
          active={canvasTool === 'pan'}
          onClick={() => setCanvasTool('pan')}
        >
          <Hand className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn label="Add table" onClick={onAddTable}>
          <Frame className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>
        <ToolbarBtn label="Add image" onClick={onAddImage}>
          <ImageIcon className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>

        <div
          className="mx-auto my-1 h-px w-[22px] shrink-0 bg-border/70"
          aria-hidden
        />

        <Popover open={jumpOpen} onOpenChange={setJumpOpen}>
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    toolBtnBase,
                    'text-muted-foreground hover:bg-muted/90 hover:text-foreground'
                  )}
                  aria-label="Find table"
                >
                  <Search className="h-[18px] w-[18px]" strokeWidth={2} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              Find table
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            className="w-[min(calc(100vw-2rem),280px)] border-border/55 bg-card/95 p-0 text-card-foreground shadow-2xl backdrop-blur-xl z-[100] dark:bg-zinc-950/96"
            side="left"
            align="start"
            sideOffset={10}
          >
            <Command className="rounded-xl border-0 bg-transparent shadow-none">
              <CommandInput placeholder="Search tables…" className="text-sm" />
              <CommandList>
                <CommandEmpty>No tables found.</CommandEmpty>
                <CommandGroup heading="Tables">
                  {sortedTables.map((t) => (
                    <CommandItem
                      key={t.id}
                      value={`${t.name} ${t.id}`}
                      onSelect={() => {
                        onJumpToTable(t.id)
                        setJumpOpen(false)
                      }}
                    >
                      {t.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Popover>
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    toolBtnBase,
                    'text-muted-foreground hover:bg-muted/90 hover:text-foreground'
                  )}
                  aria-label="Layout and display"
                >
                  <Palette className="h-[18px] w-[18px]" strokeWidth={2} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              Layout &amp; edges
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            side="left"
            align="start"
            sideOffset={10}
            className="w-64 border-border/55 bg-card/95 p-0 text-card-foreground shadow-2xl backdrop-blur-xl z-[100] dark:bg-zinc-950/96"
          >
            <div className="space-y-3 p-3">
              <p className="text-[11px] font-medium text-muted-foreground">
                Layout
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 flex-1 gap-1"
                  disabled={tablesLength === 0}
                  onClick={onAlign}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Align
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 flex-1 gap-1"
                  disabled={clusterGrouped || tablesLength === 0}
                  onClick={onDagreLayout}
                >
                  <Network className="h-3.5 w-3.5" />
                  Dagre
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] text-muted-foreground">
                  Dagre direction
                </Label>
                <Select
                  value={dagreRankDir}
                  onValueChange={(v) =>
                    onDagreDirChange(v as 'TB' | 'LR')
                  }
                  disabled={clusterGrouped || tablesLength === 0}
                >
                  <SelectTrigger className="nodrag h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[120]">
                    <SelectItem value="TB">Top → bottom</SelectItem>
                    <SelectItem value="LR">Left → right</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-2">
                <Label
                  htmlFor="tb-smooth-edges"
                  className="text-[11px] leading-tight"
                >
                  Smooth FK edges
                </Label>
                <Switch
                  id="tb-smooth-edges"
                  size="sm"
                  checked={relEdgeSmooth}
                  onCheckedChange={onRelEdgeSmoothChange}
                />
              </div>
              <Separator />
              <p className="text-[11px] font-medium text-muted-foreground">
                Smart clusters
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={clusterMode}
                  onValueChange={(v) =>
                    onClusterModeChange(v as 'heuristic' | 'gemini')
                  }
                  disabled={clusterGrouped || clusterLayoutBusy}
                >
                  <SelectTrigger className="nodrag h-8 w-[7.5rem] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[120]">
                    <SelectItem value="heuristic">Heuristic</SelectItem>
                    <SelectItem value="gemini">Gemini</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant={clusterGrouped ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 gap-1"
                  disabled={clusterLayoutBusy || tablesLength === 0}
                  onClick={() =>
                    clusterGrouped ? onUngroupClusters() : onClusterToggle()
                  }
                >
                  <LayoutDashboard className="h-3.5 w-3.5" />
                  {clusterGrouped ? 'Ungroup' : 'Cluster'}
                </Button>
              </div>
              <Separator />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-full gap-1"
                onClick={onAddCron}
              >
                <AlarmClock className="h-3.5 w-3.5" />
                Add cron node
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <ToolbarBtn label="Fit view" onClick={onFitView}>
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
        </ToolbarBtn>
      </div>

      {clustersPanel}
      {inspector}
    </div>
  )
})

export function SchemaFlowClustersCard({
  layouts,
}: {
  layouts: LayoutCluster[]
}) {
  if (layouts.length === 0) return null
  return (
    <Card className="pointer-events-auto w-[min(100vw-2rem,15rem)] border-border/55 bg-card/95 text-card-foreground shadow-2xl backdrop-blur-xl dark:bg-zinc-950/94">
      <CardHeader className="space-y-0 px-3 py-2 pb-2">
        <CardTitle className="text-xs font-semibold text-muted-foreground">
          Clusters
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-3 pb-3 pt-0">
        {layouts.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2 text-[11px] leading-tight"
          >
            <div
              className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border/50"
              style={{ backgroundColor: c.colorHex }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {c.label}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {c.tableIds.length}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
