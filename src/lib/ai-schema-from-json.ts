/**
 * Map Groq/AI JSON (see Rust system prompt) into persisted SchemaTable[] for projectToStore.
 */

import type {
  ForeignKeyRef,
  SchemaColumn,
  SchemaCronJob,
  SchemaDocumentation,
  SchemaExtension,
  SchemaFunction,
  SchemaTable,
  SchemaTrigger,
} from '@/lib/schema-designer-types'

function slugId(s: string, fallback: string): string {
  const t = s.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_|_$/g, '')
  return t || fallback
}

type AiColumn = {
  id?: string
  name: string
  data_type: string
  nullable?: boolean
  default?: string | null
  is_primary_key?: boolean
  is_unique?: boolean
  referenced_table?: string | null
  referenced_column?: string | null
  on_delete?: string | null
  on_update?: string | null
}

type AiTable = {
  id?: string
  name: string
  hex_color?: string | null
  description?: string | null
  columns: AiColumn[]
  indexes?: Array<{
    id?: string
    name: string
    columns: string[]
    unique?: boolean
  }>
}

type AiPayload = {
  tables: AiTable[]
  relationships?: Array<{
    from_table: string
    from_column: string
    to_table: string
    to_column: string
    cardinality?: string
  }>
  enums?: Array<{ name: string; values: string[] }>
}

type AiFeaturesPayload = {
  extensions?: Array<{ name: string; reason?: string | null }>
  functions?: Array<{ name: string; language?: string; returns?: string; definition?: string }>
  triggers?: Array<{
    name: string
    table_name: string
    function_name: string
    timing?: string
    events?: string[]
  }>
  cron_jobs?: Array<{ name: string; schedule: string; command: string; description?: string | null }>
}

function findTableByName(
  tables: SchemaTable[],
  name: string
): SchemaTable | undefined {
  const n = name.trim().toLowerCase()
  return tables.find((t) => t.name.trim().toLowerCase() === n)
}

function findColumnByName(
  table: SchemaTable | undefined,
  colName: string
): SchemaColumn | undefined {
  if (!table) return undefined
  const n = colName.trim().toLowerCase()
  return table.columns.find((c) => c.name.trim().toLowerCase() === n)
}

export function parseAiSchemaJsonBlock(fullText: string): AiPayload | null {
  const fencedBlocks = [...fullText.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (fencedBlocks.length > 0) {
    for (let i = fencedBlocks.length - 1; i >= 0; i -= 1) {
      const block = fencedBlocks[i]?.[1]?.trim()
      if (!block) continue
      try {
        const parsed = JSON.parse(block) as AiPayload
        if (Array.isArray(parsed.tables) && parsed.tables.length > 0) {
          return parsed
        }
      } catch {
        // try older fenced block
      }
    }
  }
  // Some providers return raw JSON without markdown code fences.
  const trimmed = fullText.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as AiPayload
      if (Array.isArray(parsed.tables) && parsed.tables.length > 0) {
        return parsed
      }
      return null
    } catch {
      return null
    }
  }
  return null
}

export function parseAiFeaturesJsonBlock(fullText: string): AiFeaturesPayload | null {
  const blocks = [...fullText.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (blocks.length < 2) return null
  try {
    return JSON.parse(blocks[1][1].trim()) as AiFeaturesPayload
  } catch {
    return null
  }
}

export function parseAiDocumentationMarkdown(fullText: string): string {
  const blocks = [...fullText.matchAll(/```json\s*[\s\S]*?```/gi)]
  if (blocks.length === 0) return fullText.trim()
  const lastBlock = blocks[blocks.length - 1]
  const after = fullText.slice((lastBlock.index ?? 0) + lastBlock[0].length)
  return after.trim()
}

export function aiPayloadToSchemaTables(payload: AiPayload): SchemaTable[] {
  const raw: SchemaTable[] = payload.tables.map((t, ti) => {
    const tid = t.id?.trim() || slugId(t.name, `table-${ti}`)
    const columns: SchemaColumn[] = t.columns.map((c, ci) => {
      const cid = c.id?.trim() || slugId(`${tid}_${c.name}`, `col-${ti}-${ci}`)
      return {
        id: cid,
        name: c.name,
        data_type: c.data_type,
        nullable: c.nullable !== false,
        default_value: c.default ?? null,
        is_primary_key: c.is_primary_key === true,
        is_unique: c.is_unique === true,
        foreign_key: null,
      }
    })
    return {
      id: tid,
      name: t.name,
      hex_color: t.hex_color ?? null,
      description: t.description ?? null,
      columns,
      indexes: (t.indexes ?? []).map((ix, ii) => ({
        id: ix.id?.trim() || `idx-${tid}-${ii}`,
        name: ix.name,
        columns: ix.columns,
        unique: ix.unique === true,
        method: 'btree',
      })),
      position: null,
    }
  })

  const byName = (name: string) => findTableByName(raw, name)

  for (const t of raw) {
    const ai = payload.tables.find(
      (x) => slugId(x.name, '') === slugId(t.name, '') || x.id === t.id
    )
    if (!ai) continue
    for (let i = 0; i < t.columns.length; i += 1) {
      const col = t.columns[i]
      const ac = ai.columns[i]
      if (!ac?.referenced_table) continue
      const tgt = byName(ac.referenced_table)
      const tgtCol =
        findColumnByName(tgt, ac.referenced_column || 'id') ||
        tgt?.columns.find((c) => c.is_primary_key)
      if (!tgt || !tgtCol) continue
      const fk: ForeignKeyRef = {
        target_table_id: tgt.id,
        target_column_id: tgtCol.id,
        on_delete: ac.on_delete ?? null,
        on_update: ac.on_update ?? null,
      }
      col.foreign_key = fk
    }
  }

  for (const rel of payload.relationships ?? []) {
    const src = byName(rel.from_table)
    const tgt = byName(rel.to_table)
    const srcCol = findColumnByName(src, rel.from_column)
    const tgtCol = findColumnByName(tgt, rel.to_column)
    if (!src || !tgt || !srcCol || !tgtCol) continue
    srcCol.foreign_key = {
      target_table_id: tgt.id,
      target_column_id: tgtCol.id,
      on_delete: 'CASCADE',
      on_update: null,
    }
  }

  return raw
}

export function firstTableAccentColor(tables: SchemaTable[]): string | null {
  const c = tables.find((t) => t.hex_color && /^#[0-9A-Fa-f]{6}$/.test(t.hex_color))
  return c?.hex_color ?? null
}

function cleanId(v: string, fallback: string): string {
  const n = slugId(v, fallback)
  return n || fallback
}

export function aiFeaturesToSchemaExtras(
  payload: AiFeaturesPayload | null,
  tables: SchemaTable[]
): {
  extensions: SchemaExtension[]
  functions: SchemaFunction[]
  triggers: SchemaTrigger[]
  cronJobs: SchemaCronJob[]
} {
  if (!payload) {
    return { extensions: [], functions: [], triggers: [], cronJobs: [] }
  }
  const tableByName = new Map(tables.map((t) => [t.name.trim().toLowerCase(), t]))
  return {
    extensions: (payload.extensions ?? []).map((x, i) => ({
      id: cleanId(x.name, `extension-${i}`),
      name: x.name,
      reason: x.reason ?? null,
    })),
    functions: (payload.functions ?? []).map((x, i) => ({
      id: cleanId(x.name, `function-${i}`),
      name: x.name,
      language: x.language ?? 'plpgsql',
      returns: x.returns ?? 'void',
      definition: x.definition ?? '',
      x: 0,
      y: 0,
    })),
    triggers: (payload.triggers ?? []).map((x, i) => ({
      id: cleanId(x.name, `trigger-${i}`),
      name: x.name,
      table_id: tableByName.get(x.table_name.trim().toLowerCase())?.id ?? x.table_name,
      function_name: x.function_name,
      timing: x.timing ?? 'AFTER',
      events: x.events ?? ['INSERT'],
      x: 0,
      y: 0,
    })),
    cronJobs: (payload.cron_jobs ?? []).map((x, i) => ({
      id: cleanId(x.name, `cron-${i}`),
      name: x.name,
      schedule: x.schedule,
      command: x.command,
      description: x.description ?? null,
    })),
  }
}

export function markdownToSchemaDocumentation(markdown: string): SchemaDocumentation {
  return {
    overview: markdown.trim(),
    capacity_estimate: null,
    design_rationale: null,
    migration_notes: null,
  }
}
