'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import type { SchemaError } from '@/lib/schema-designer/types'

export function ErrorToast({ error }: { error: SchemaError | null }) {
  useEffect(() => {
    if (!error) return
    if (error.type === 'RATE_LIMITED') {
      toast.error(`Rate limited. Try again in ${error.retryAfter}s.`)
      return
    }
    const message = 'message' in error ? error.message : 'The schema response could not be parsed.'
    toast.error(message)
  }, [error])

  return null
}
