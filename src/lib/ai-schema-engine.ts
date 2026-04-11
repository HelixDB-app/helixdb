import type { MilestoneKey, OpenRouterModel } from '@/lib/schema-designer-types'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions'

export const OPENROUTER_FREE_MODELS: OpenRouterModel[] = [
  { id: 'arcee-ai/trinity-mini:free', label: 'Trinity Mini', contextK: 128, free: true, latencyTier: 'fast' },
  { id: 'arcee-ai/trinity-mini:free', label: 'Llama 4 Maverick', contextK: 128, free: true, latencyTier: 'balanced' },
  { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B IT', contextK: 128, free: true, latencyTier: 'balanced' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct:free', label: 'Mistral Small 3.1', contextK: 128, free: true, latencyTier: 'fast' },
  { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1', contextK: 64, free: true, latencyTier: 'slow' },
  { id: 'qwen/qwen3-235b-a22b:free', label: 'Qwen 3 235B', contextK: 128, free: true, latencyTier: 'slow' },
  { id: 'microsoft/phi-4-reasoning-plus:free', label: 'Phi 4 Reasoning Plus', contextK: 64, free: true, latencyTier: 'balanced' },
]

export class SchemaParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaParseError'
  }
}

export class SchemaRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaRateLimitError'
  }
}

export class SchemaNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaNetworkError'
  }
}

export interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenRouterRequest {
  apiKey: string
  model: string
  messages: OpenRouterChatMessage[]
  reasoningEnabled?: boolean
  maxTokens?: number
  jsonMode?: boolean
}

export interface OpenRouterStreamResult {
  text: string
  raw: string
}

export function buildFallbackChain(preferredModel?: string): string[] {
  const all = OPENROUTER_FREE_MODELS.map((m) => m.id)
  if (!preferredModel || !all.includes(preferredModel)) return all
  return [preferredModel, ...all.filter((m) => m !== preferredModel)]
}

function detectMilestones(buffer: string, seen: Set<MilestoneKey>): MilestoneKey[] {
  const markers: Array<{ key: MilestoneKey; marker: string }> = [
    { key: 'meta', marker: '"schema_meta":' },
    { key: 'tables', marker: '"tables":' },
    { key: 'indexes', marker: '"indexes":' },
    { key: 'graph', marker: '"react_flow_graph":' },
    { key: 'nodes', marker: '"nodes":' },
    { key: 'docs', marker: '"schema_doc":' },
  ]
  const next: MilestoneKey[] = []
  for (const marker of markers) {
    if (!seen.has(marker.key) && buffer.includes(marker.marker)) {
      seen.add(marker.key)
      next.push(marker.key)
    }
  }
  if (!seen.has('first_table') && /CREATE\s+TABLE/i.test(buffer)) {
    seen.add('first_table')
    next.push('first_table')
  }
  return next
}

function parseStreamDelta(data: string): string {
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
    }
    const choice = parsed.choices?.[0]
    return choice?.delta?.content ?? choice?.message?.content ?? ''
  } catch {
    return ''
  }
}

async function assertResponseOk(res: Response): Promise<void> {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  if (res.status === 429 || body.includes('rate')) {
    throw new SchemaRateLimitError(`OpenRouter rate limited (${res.status})`)
  }
  throw new SchemaNetworkError(`OpenRouter failed (${res.status}): ${body || res.statusText}`)
}

export async function callOpenRouterSync(request: OpenRouterRequest): Promise<string> {
  const res = await fetch(OPENROUTER_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: false,
      reasoning: { enabled: request.reasoningEnabled ?? true },
      max_tokens: request.maxTokens ?? 16384,
      ...(request.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
    }),
  }).catch((err) => {
    throw new SchemaNetworkError(
      err instanceof Error ? err.message : 'Unknown network error'
    )
  })
  await assertResponseOk(res)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return json.choices?.[0]?.message?.content ?? ''
}

export async function callOpenRouterStream(
  request: OpenRouterRequest,
  onChunk: (chunk: string) => void,
  onMilestone: (milestone: MilestoneKey) => void,
  signal?: AbortSignal
): Promise<OpenRouterStreamResult> {
  const res = await fetch(OPENROUTER_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      reasoning: { enabled: request.reasoningEnabled ?? true },
      max_tokens: request.maxTokens ?? 16384,
      ...(request.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
    }),
    signal,
  }).catch((err) => {
    throw new SchemaNetworkError(
      err instanceof Error ? err.message : 'Unknown network error'
    )
  })
  await assertResponseOk(res)
  if (!res.body) throw new SchemaNetworkError('Missing response stream body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const seen = new Set<MilestoneKey>()
  let lineBuffer = ''
  let fullText = ''
  let rawData = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    lineBuffer += chunk
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      rawData += `${payload}\n`
      const delta = parseStreamDelta(payload)
      if (!delta) continue
      fullText += delta
      onChunk(delta)
      const hits = detectMilestones(fullText, seen)
      for (const milestone of hits) onMilestone(milestone)
    }
  }
  if (!seen.has('done')) onMilestone('done')
  return { text: fullText, raw: rawData }
}

export function extractSchemaJSON(raw: string): string {
  if (!raw.trim()) throw new SchemaParseError('Empty model output')
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  const start = cleaned.indexOf('{')
  if (start === -1) throw new SchemaParseError('No JSON object found')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) throw new SchemaParseError('Unterminated JSON object')
  const jsonSlice = cleaned.slice(start, end)
  JSON.parse(jsonSlice)
  return jsonSlice
}

export async function repairBrokenSchemaJSON(
  request: OpenRouterRequest & { brokenJsonText: string }
): Promise<string> {
  const repairPrompt = [
    'Repair the following malformed JSON into valid JSON.',
    'Do not change keys or semantic meaning.',
    'Return JSON only. No markdown. No explanation.',
    '',
    request.brokenJsonText,
  ].join('\n')
  return callOpenRouterSync({
    ...request,
    messages: [{ role: 'user', content: repairPrompt }],
    reasoningEnabled: false,
    jsonMode: true,
    maxTokens: 12000,
  })
}
