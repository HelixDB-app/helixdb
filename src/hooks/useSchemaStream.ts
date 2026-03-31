'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { groupSectionsFromMarkdown } from '@/lib/schema-designer/project-utils'
import { streamSchemaGeneration } from '@/lib/schema-designer/groqClient'
import { safeParseSchemaResponse } from '@/lib/schema-designer/schemaParser'
import type {
  ConversationMessage,
  GenerationOptions,
  SchemaData,
  SchemaError,
} from '@/lib/schema-designer/types'

interface StreamGenerationParams {
  prompt: string
  model: string
  options: GenerationOptions
  conversationHistory: ConversationMessage[]
}

export function useSchemaStream() {
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle')
  const [streamText, setStreamText] = useState('')
  const [reasoningText, setReasoningText] = useState('')
  const [rawResponse, setRawResponse] = useState('')
  const [error, setError] = useState<SchemaError | null>(null)
  const activeRef = useRef(true)

  const reset = useCallback(() => {
    setStatus('idle')
    setStreamText('')
    setReasoningText('')
    setRawResponse('')
    setError(null)
  }, [])

  const start = useCallback(async ({ prompt, model, options, conversationHistory }: StreamGenerationParams) => {
    reset()
    setStatus('streaming')

    try {
      const generator = streamSchemaGeneration(prompt, model, options, conversationHistory)
      let fullResponse = ''
      while (true) {
        const result = await generator.next()
        if (result.done) {
          fullResponse = result.value
          break
        }
        if (!activeRef.current) break
        if (result.value.type === 'token') {
          setStreamText((current) => current + result.value.content)
        } else {
          setReasoningText((current) => current + result.value.content)
        }
      }

      setRawResponse(fullResponse)
      const parsed = safeParseSchemaResponse(fullResponse)
      if (parsed.error) {
        setError(parsed.error)
        setStatus('error')
        return {
          schema: null,
          narrative: '',
          rawResponse: fullResponse,
          error: parsed.error,
        }
      }

      setStatus('done')
      return {
        schema: parsed.schema as SchemaData,
        narrative: parsed.narrative,
        rawResponse: fullResponse,
        error: null,
      }
    } catch (err) {
      const nextError: SchemaError = {
        type: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Schema generation failed.',
      }
      setError(nextError)
      setStatus('error')
      return {
        schema: null,
        narrative: '',
        rawResponse: '',
        error: nextError,
      }
    }
  }, [reset])

  const sections = useMemo(() => groupSectionsFromMarkdown(streamText), [streamText])

  return {
    status,
    streamText,
    reasoningText,
    rawResponse,
    error,
    sections,
    start,
    reset,
  }
}
