'use client'

import { useCallback, useMemo } from 'react'
import { applySchemaLayout } from '@/lib/schema-designer/reactflowLayout'
import type { SchemaData } from '@/lib/schema-designer/types'

export function useCanvasLayout(
  schema: SchemaData | null,
  direction: 'LR' | 'TB'
) {
  const layoutedSchema = useMemo(
    () => (schema ? applySchemaLayout(schema, direction) : null),
    [schema, direction]
  )

  const applyLayout = useCallback(
    (nextSchema: SchemaData, nextDirection: 'LR' | 'TB' = direction) =>
      applySchemaLayout(nextSchema, nextDirection),
    [direction]
  )

  return useMemo(
    () => ({
      layoutedSchema,
      applyLayout,
    }),
    [applyLayout, layoutedSchema]
  )
}
