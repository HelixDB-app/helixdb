'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { SchemaDesignerAiStreamPayload } from '@/lib/tauri'
import type { AgentStage } from '@/lib/schema-designer-types'
import { isTauri } from '@/lib/tauri-runtime'
import { providerForSchemaAiModel } from '@/lib/groq-models'
import {
  schemaDesignerAiPipelineStart,
  schemaDesignerAiStreamCancel,
  schemaDesignerAiStreamStart,
} from '@/lib/tauri'

type StageStatus = 'start' | 'end' | 'error'
type StageEventPayload = {
  requestId: string
  stage: AgentStage
  status: StageStatus
  message?: string
  retryCount?: number
  provider?: string
}

export function useSchemaAiStream() {
  const [streaming, setStreaming] = useState(false)
  const [buffer, setBuffer] = useState('')
  const [agentLog, setAgentLog] = useState<string[]>([])
  const [stage, setStage] = useState<AgentStage>('idle')
  const [stageError, setStageError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [currentProvider, setCurrentProvider] = useState<string>('groq')
  const requestIdRef = useRef<string | null>(null)
  const unlistenRef = useRef<UnlistenFn[]>([])
  const bufferRef = useRef('')
  const stageErrorsRef = useRef<Record<string, string>>({})

  useEffect(() => {
    return () => {
      void Promise.all(unlistenRef.current.map((u) => u()))
    }
  }, [])

  const startStream = useCallback(
    async (
      payload: SchemaDesignerAiStreamPayload,
      opts?: {
        onDone?: (error: string | null, fullText: string) => void
        usePipeline?: boolean
      }
    ) => {
      if (!isTauri()) {
        throw new Error('AI generation requires the pgStudio desktop app.')
      }
      for (const u of unlistenRef.current) {
        void u()
      }
      unlistenRef.current = []
      setBuffer('')
      bufferRef.current = ''
      setAgentLog([])
      setStreaming(true)
      setStage('planning')
      setStageError(null)
      setRetryCount(0)
      const guessedProvider =
        payload.options?.provider && payload.options.provider !== 'auto'
          ? payload.options.provider
          : providerForSchemaAiModel(payload.model)
      setCurrentProvider(guessedProvider)
      stageErrorsRef.current = {}

      const tokenUn = await listen<{ requestId: string; chunk: { type?: string; text?: string } }>(
        'schema-designer-ai-token',
        (ev) => {
          if (ev.payload?.requestId !== requestIdRef.current) return
          const text = ev.payload?.chunk?.text
          if (typeof text === 'string' && text.length > 0) {
            setBuffer((b) => {
              const next = b + text
              bufferRef.current = next
              return next
            })
          }
        }
      )
      const stageUn = await listen<StageEventPayload>('schema-designer-ai-stage', (ev) => {
        if (ev.payload?.requestId !== requestIdRef.current) return
        const payload = ev.payload
        if (payload.provider) setCurrentProvider(payload.provider)
        if (typeof payload.retryCount === 'number') setRetryCount(payload.retryCount)
        if (payload.status === 'start' || payload.status === 'end') {
          setStage(payload.stage)
          if (payload.status === 'start') setStageError(null)
        }
        if (payload.status === 'error') {
          const message = payload.message ?? `Stage ${payload.stage} failed`
          stageErrorsRef.current[payload.stage] = message
          setStage(payload.stage)
          setStageError(message)
          setAgentLog((log) => [...log, `// stage-error(${payload.stage}): ${message}`])
        }
      })
      const doneUn = await listen<{ requestId: string; error?: string | null }>(
        'schema-designer-ai-done',
        (ev) => {
          if (ev.payload?.requestId !== requestIdRef.current) return
          const err = ev.payload?.error ?? null
          if (err && err !== 'Cancelled') {
            setStage('error')
            setStageError(err)
            setAgentLog((log) => [...log, `// error: ${err}`])
          } else if (!err) {
            setStage('done')
          } else {
            setStage('idle')
            setStageError(null)
          }
          opts?.onDone?.(err, bufferRef.current)
          setStreaming(false)
          requestIdRef.current = null
        }
      )
      unlistenRef.current = [tokenUn, stageUn, doneUn]

      const requestId = opts?.usePipeline
        ? await schemaDesignerAiPipelineStart(payload)
        : await schemaDesignerAiStreamStart(payload)
      requestIdRef.current = requestId
      return requestId
    },
    []
  )

  const cancelStream = useCallback(async () => {
    const id = requestIdRef.current
    if (id) {
      await schemaDesignerAiStreamCancel(id)
    }
    setStreaming(false)
    setStage('idle')
    setStageError(null)
    requestIdRef.current = null
  }, [])

  return {
    streaming,
    buffer,
    setBuffer,
    agentLog,
    setAgentLog,
    stage,
    stageError,
    retryCount,
    currentProvider,
    startStream,
    cancelStream,
  }
}
