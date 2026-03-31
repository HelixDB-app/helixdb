'use client'

import { memo } from 'react'
import type { NodeProps } from 'reactflow'

export type ClusterBackgroundData = {
  label: string
  colorHex: string
}

function ClusterBackgroundInner({ data }: NodeProps<ClusterBackgroundData>) {
  const { label, colorHex } = data
  return (
    <div
      className="pointer-events-none relative box-border h-full w-full rounded-2xl border-2 border-dashed shadow-none"
      style={{
        borderColor: colorHex,
        backgroundColor: `color-mix(in oklch, ${colorHex} 10%, transparent)`,
      }}
    >
      <div
        className="absolute left-3 top-2 max-w-[70%] truncate text-[11px] font-semibold tracking-tight"
        style={{ color: colorHex }}
      >
        {label}
      </div>
    </div>
  )
}

export const ClusterBackground = memo(ClusterBackgroundInner)
