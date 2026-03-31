'use client'

import { Loader2 } from 'lucide-react'

export function LoadingOverlay({
  title = 'Generating schema',
  description = 'Streaming the design plan and arranging your tables…',
}: {
  title?: string
  description?: string
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-[28px] border border-white/10 bg-[#111111]/90 p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3 text-white">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-indigo-400/30 bg-indigo-500/15 text-indigo-200">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.2em] text-zinc-400 uppercase">AI in progress</p>
            <h3 className="text-xl font-semibold">{title}</h3>
            <p className="text-sm text-zinc-400">{description}</p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="rounded-3xl border border-white/10 bg-zinc-950/70 p-4"
            >
              <div className="mb-4 h-3 w-20 animate-pulse rounded-full bg-white/10" />
              <div className="mb-3 h-8 animate-pulse rounded-2xl bg-gradient-to-r from-indigo-500/20 via-cyan-500/10 to-emerald-500/20" />
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((__, row) => (
                  <div
                    key={row}
                    className="h-8 animate-pulse rounded-xl bg-white/5"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
