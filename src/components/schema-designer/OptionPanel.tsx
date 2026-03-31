'use client'

import { ChevronDown, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { GenerationOptions } from '@/lib/schema-designer/types'

function RangeField({
  id,
  label,
  min,
  max,
  step,
  value,
  displayValue,
  onChange,
}: {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  displayValue?: string
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs font-medium text-zinc-300">
          {label}
        </Label>
        <span className="text-xs text-zinc-500">{displayValue ?? value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-indigo-400"
      />
    </div>
  )
}

export function OptionPanel({
  open,
  onOpenChange,
  options,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: GenerationOptions
  onChange: (updates: Partial<GenerationOptions>) => void
}) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-black/20 backdrop-blur-xl">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-zinc-200">
            <Settings2 className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-white">Advanced options</p>
            <p className="text-xs text-zinc-500">Tune model behavior, output depth, and naming style.</p>
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="grid gap-5 border-t border-white/10 px-4 py-4 md:grid-cols-2">
          <RangeField
            id="schema-temp"
            label="Temperature"
            min={0}
            max={2}
            step={0.1}
            value={options.temperature}
            displayValue={options.temperature.toFixed(1)}
            onChange={(value) => onChange({ temperature: value })}
          />
          <RangeField
            id="schema-max-tokens"
            label="Max tokens"
            min={1024}
            max={16384}
            step={256}
            value={options.maxTokens}
            onChange={(value) => onChange({ maxTokens: value })}
          />

          <div className="space-y-2">
            <Label className="text-xs font-medium text-zinc-300">Output format</Label>
            <Select
              value={options.outputFormat}
              onValueChange={(value) => onChange({ outputFormat: value as GenerationOptions['outputFormat'] })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-white/10 bg-white/5 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
                <SelectItem value="detailed">Detailed</SelectItem>
                <SelectItem value="minimal">Minimal</SelectItem>
                <SelectItem value="with-indexes">With indexes</SelectItem>
                <SelectItem value="with-sample-data">With sample data</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-zinc-300">Normalization</Label>
            <Select
              value={options.normalizationLevel}
              onValueChange={(value) => onChange({ normalizationLevel: value as GenerationOptions['normalizationLevel'] })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-white/10 bg-white/5 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
                <SelectItem value="1NF">1NF</SelectItem>
                <SelectItem value="2NF">2NF</SelectItem>
                <SelectItem value="3NF">3NF</SelectItem>
                <SelectItem value="BCNF">BCNF</SelectItem>
                <SelectItem value="denormalized">Denormalized</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-zinc-300">Naming convention</Label>
            <Select
              value={options.namingConvention}
              onValueChange={(value) => onChange({ namingConvention: value as GenerationOptions['namingConvention'] })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-white/10 bg-white/5 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
                <SelectItem value="snake_case">snake_case</SelectItem>
                <SelectItem value="camelCase">camelCase</SelectItem>
                <SelectItem value="PascalCase">PascalCase</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium text-zinc-300">Reasoning effort</Label>
            <Select
              value={options.reasoningEffort}
              onValueChange={(value) => onChange({ reasoningEffort: value as GenerationOptions['reasoningEffort'] })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-white/10 bg-white/5 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl border-white/10 bg-[#161616] text-zinc-100">
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 md:col-span-2 md:grid-cols-2 xl:grid-cols-4">
            {[
              ['includeEnums', 'Include enums'],
              ['includeAuditColumns', 'Audit columns'],
              ['includeIndexes', 'Performance indexes'],
              ['includeSampleData', 'Sample data'],
            ].map(([key, label]) => (
              <div key={key} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
                <span className="text-sm text-zinc-200">{label}</span>
                <Switch
                  checked={Boolean(options[key as keyof GenerationOptions])}
                  onCheckedChange={(checked) => onChange({ [key]: checked } as Partial<GenerationOptions>)}
                />
              </div>
            ))}
          </div>

          <div className="md:col-span-2">
            <Button
              type="button"
              variant="ghost"
              className="h-9 rounded-2xl px-0 text-xs text-zinc-400 hover:bg-transparent hover:text-zinc-100"
              onClick={() => onOpenChange(false)}
            >
              Collapse advanced controls
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
