'use client'

import { Suspense } from 'react'
import { AISchemaDesigner } from '@/components/ai-schema-designer'
import { ReactFlowProvider } from 'reactflow'

export default function AISchemaDesignerPage() {
  return (
    <ReactFlowProvider>
      <Suspense fallback={null}>
        <AISchemaDesigner />
      </Suspense>
    </ReactFlowProvider>
  )
}
