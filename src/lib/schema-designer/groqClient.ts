'use client'

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/tauri-runtime'
import type {
  ConversationMessage,
  GenerationOptions,
  StreamChunk,
} from '@/lib/schema-designer/types'

export class SchemaGenerationError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message)
    this.name = 'SchemaGenerationError'
  }
}

interface StreamEventPayload {
  requestId: string
  content: string
}

export async function* streamSchemaGeneration(
  prompt: string,
  model: string,
  options: GenerationOptions,
  conversationHistory: ConversationMessage[]
): AsyncGenerator<StreamChunk, string, void> {
  if (!isTauri()) {
    throw new SchemaGenerationError(
      'Schema generation is available from the desktop runtime only.'
    )
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const queue: Array<StreamChunk | { done: true; fullResponse: string } | { error: string }> = []
  let fullResponse = ''
  let settled = false
  let wake: (() => void) | null = null

  const notify = () => {
    wake?.()
    wake = null
  }

  const listeners: UnlistenFn[] = []
  const attach = async (
    event: string,
    handler: (payload: StreamEventPayload) => void
  ) => {
    const unlisten = await listen<StreamEventPayload>(event, ({ payload }) => {
      if (payload.requestId !== requestId) return
      handler(payload)
    })
    listeners.push(unlisten)
  }

  await Promise.all([
    attach('schema-designer://stream-token', (payload) => {
      fullResponse += payload.content
      queue.push({ type: 'token', content: payload.content })
      notify()
    }),
    attach('schema-designer://stream-reasoning', (payload) => {
      queue.push({ type: 'reasoning', content: payload.content })
      notify()
    }),
    attach('schema-designer://stream-error', (payload) => {
      queue.push({ error: payload.content })
      notify()
    }),
    attach('schema-designer://stream-done', (payload) => {
      settled = true
      queue.push({ done: true, fullResponse: payload.content || fullResponse })
      notify()
    }),
  ])

  void invoke<string>('schema_designer_v2_stream_generate', {
    requestId,
    prompt,
    model,
    options,
    conversationHistory,
  }).catch((error) => {
    queue.push({ error: error instanceof Error ? error.message : String(error) })
    notify()
  })

  try {
    while (!settled || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }

      const next = queue.shift()
      if (!next) continue
      if ('error' in next) {
        throw new SchemaGenerationError(next.error)
      }
      if ('done' in next) {
        settled = true
        return next.fullResponse
      }
      yield next
    }
  } finally {
    await Promise.all(listeners.map((unlisten) => unlisten()))
  }

  return fullResponse
}
