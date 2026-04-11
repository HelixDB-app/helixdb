'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import ReactFlow, {
  Background,
  applyNodeChanges,
  ConnectionLineType,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  Copy,
  Database,
  Key,
  KeyRound,
  Link2,
  Loader2,
  Send,
  Settings2,
  Sparkles,
  Square,
  Table2,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  OPENROUTER_FREE_MODELS,
  SchemaParseError,
  SchemaRateLimitError,
  buildFallbackChain,
  callOpenRouterStream,
  callOpenRouterSync,
  extractSchemaJSON,
  repairBrokenSchemaJSON,
} from '@/lib/ai-schema-engine'
import {
  type QualityMode,
  buildRecoveryPrompt,
  buildSchemaUpdateMessage,
  buildSystemPrompt,
  buildUserMessage,
} from '@/lib/ai-schema-prompts'
import { aiSchemaViewHref } from '@/lib/ai-schema-routes'
import {
  loadAISchemaProject,
  saveAISchemaProject,
} from '@/lib/ai-schema-project-storage'
import type { AISchemaResult, MilestoneKey } from '@/lib/schema-designer-types'
import { parseSchemaSQL } from '@/lib/schema-designer-utils'
import type { Column, Relationship, Table as SchemaStoreTable } from '@/lib/schema-store'
import { useAISchemaStore } from '@/stores/ai-schema-store'
import { readOpenRouterApiKeyFromEnv, useSettingsStore } from '@/stores/settings-store'

const MILESTONE_LABELS: Array<{ key: MilestoneKey; label: string }> = [
  { key: 'meta', label: 'Meta' },
  { key: 'tables', label: 'Tables' },
  { key: 'indexes', label: 'Indexes' },
  { key: 'graph', label: 'Graph' },
  { key: 'docs', label: 'Docs' },
  { key: 'done', label: 'Done' },
]

function detectDomain(input: string): string {
  const lower = input.toLowerCase()
  if (lower.includes('health') || lower.includes('hospital')) return 'Healthcare'
  if (lower.includes('ecom') || lower.includes('catalog') || lower.includes('order')) return 'E-Commerce'
  if (lower.includes('finance') || lower.includes('payment') || lower.includes('ledger')) return 'FinTech'
  if (lower.includes('task') || lower.includes('project') || lower.includes('issue')) return 'SaaS / Project Management'
  return 'General SaaS'
}

function collectSql(result: AISchemaResult | null): string {
  if (!result) return ''
  const order = [
    'extensions',
    'tables',
    'indexes',
    'triggers',
    'functions',
    'rls',
    'cron_jobs',
    'materialized_views',
  ]
  return order
    .map((key) => result.sql_blocks[key])
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n')
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

type AIGraphColumn = {
  name: string
  type: string
  constraints: string[]
}

type AITableNodeData = {
  label: string
  columns: AIGraphColumn[]
}

function parseColumns(rawData: Record<string, unknown>): AIGraphColumn[] {
  const rawColumns = Array.isArray(rawData.columns)
    ? rawData.columns
    : Array.isArray(rawData.fields)
      ? rawData.fields
      : []
  return rawColumns
    .map((col) => {
      if (!col || typeof col !== 'object') return null
      const candidate = col as Record<string, unknown>
      const nameRaw =
        (typeof candidate.name === 'string' && candidate.name) ||
        (typeof candidate.column_name === 'string' && candidate.column_name) ||
        (typeof candidate.field === 'string' && candidate.field) ||
        ''
      const name = nameRaw.trim()
      if (!name) return null
      const typeRaw =
        (typeof candidate.type === 'string' && candidate.type.trim() && candidate.type) ||
        (typeof candidate.data_type === 'string' && candidate.data_type.trim() && candidate.data_type) ||
        (typeof candidate.sql_type === 'string' && candidate.sql_type.trim() && candidate.sql_type) ||
        'text'
      const constraints = Array.isArray(candidate.constraints)
        ? candidate.constraints.filter((item): item is string => typeof item === 'string')
        : []
      return { name, type: typeRaw, constraints }
    })
    .filter((col): col is AIGraphColumn => Boolean(col))
}

function normalizeGraphTableLabel(label: string): string {
  return label.trim().replace(/"/g, '').toLowerCase()
}

function formatStoreColumnTypeForErd(t: Column['type']): string {
  const labels: Record<Column['type'], string> = {
    string: 'varchar',
    text: 'text',
    integer: 'integer',
    numeric: 'numeric',
    boolean: 'boolean',
    timestamp: 'timestamptz',
    uuid: 'uuid',
    json: 'jsonb',
  }
  return labels[t]
}

/** When the model omits react_flow column lists, derive rows from generated CREATE TABLE SQL. */
function buildSqlColumnsByTableName(
  tables: SchemaStoreTable[],
  relationships: Relationship[]
): Map<string, AIGraphColumn[]> {
  const fkSource = new Set(relationships.map((r) => `${r.sourceTableId}\0${r.sourceColumnId}`))
  const map = new Map<string, AIGraphColumn[]>()
  for (const table of tables) {
    const cols: AIGraphColumn[] = table.columns.map((col: Column) => {
      const constraints: string[] = []
      if (col.isPrimaryKey) constraints.push('PRIMARY KEY')
      if (col.isUnique) constraints.push('UNIQUE')
      if (!col.nullable) constraints.push('NOT NULL')
      if (col.default) constraints.push(`DEFAULT ${col.default}`)
      if (fkSource.has(`${table.id}\0${col.id}`)) constraints.push('FOREIGN KEY')
      return {
        name: col.name,
        type: formatStoreColumnTypeForErd(col.type),
        constraints,
      }
    })
    map.set(normalizeGraphTableLabel(table.name), cols)
  }
  return map
}

function cardinalityText(rawEdge: { label?: unknown; data?: { cardinality?: unknown } }): string {
  if (typeof rawEdge?.label === 'string' && rawEdge.label.trim()) return rawEdge.label
  if (typeof rawEdge?.data?.cardinality === 'string' && rawEdge.data.cardinality.trim()) {
    return rawEdge.data.cardinality
  }
  return '1:N'
}

/**
 * Pixel offset from node top to vertical center of first column row (header + border only; ERD style, no sub-header).
 * Tuned for `py-2.5` title + `text-sm` title line + 1px border.
 */
const AI_TABLE_NODE_LEAD_PX = 59
const AI_TABLE_ROW_PX = 36

const HANDLE_CLASS =
  '!h-2 !w-2 !rounded-full !border !border-slate-400/90 !bg-[#1a1f2e] !shadow-sm transition-colors hover:!border-slate-200'

function columnKeyFlags(constraints: string[] | undefined | null) {
  const list = Array.isArray(constraints) ? constraints : []
  const isPrimary = list.some((flag) => /pk|primary/i.test(flag))
  const isForeign = list.some((flag) => /fk|foreign/i.test(flag))
  return { isPrimary, isForeign }
}

function ColumnKeyIcon({ isPrimary, isForeign }: { isPrimary: boolean; isForeign: boolean }) {
  if (isPrimary) {
    return (
      <Key
        className="h-3.5 w-3.5 shrink-0 text-amber-400 drop-shadow-[0_0_10px_rgba(251,191,36,0.28)]"
        strokeWidth={2.25}
        aria-hidden
      />
    )
  }
  if (isForeign) {
    return (
      <Key
        className="h-3.5 w-3.5 shrink-0 text-slate-400"
        strokeWidth={2}
        aria-hidden
      />
    )
  }
  return <span className="inline-block h-3.5 w-3.5 shrink-0" aria-hidden />
}

function AITableNode({ data, selected }: NodeProps<AITableNodeData>) {
  const fields = Array.isArray(data?.columns) ? data.columns : []
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollFade, setShowScrollFade] = useState(false)

  const updateScrollFade = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const canScroll = el.scrollHeight > el.clientHeight + 2
    const notAtBottom = el.scrollTop + el.clientHeight < el.scrollHeight - 6
    setShowScrollFade(canScroll && notAtBottom)
  }, [])

  const fieldSig = fields.map((f) => `${f.name}:${f.type}`).join('\n')
  useLayoutEffect(() => {
    updateScrollFade()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => updateScrollFade())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fieldSig, updateScrollFade])

  return (
    <div
      className={`w-[min(calc(100vw-2rem),380px)] min-w-[280px] max-w-[380px] overflow-hidden rounded-lg border bg-[#161b26] shadow-[0_8px_32px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.04)_inset] transition-[box-shadow,ring] ${
        selected
          ? 'border-sky-500/50 ring-2 ring-sky-400/35 ring-offset-2 ring-offset-[#12151c]'
          : 'border-slate-600/40'
      }`}
    >
      <div className="cursor-grab select-none border-b border-slate-700/80 bg-[#1c2333] px-3.5 py-2.5 active:cursor-grabbing">
        <p className="truncate text-sm font-bold tracking-tight text-white">{data.label}</p>
      </div>
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={updateScrollFade}
          className="nodrag nowheel max-h-[min(352px,40vh)] overflow-y-auto overflow-x-hidden scroll-smooth [scrollbar-color:rgba(100,116,139,0.45)_rgba(30,41,59,0.35)] [scrollbar-width:thin] [overscroll-behavior:contain] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:mx-0.5 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-slate-900/50 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-600/55 [&::-webkit-scrollbar-thumb]:transition-colors hover:[&::-webkit-scrollbar-thumb]:bg-slate-500/75"
        >
          {fields.length > 0 ? (
            fields.map((field, index) => {
              const top = AI_TABLE_NODE_LEAD_PX + index * AI_TABLE_ROW_PX
              const { isPrimary, isForeign } = columnKeyFlags(
                Array.isArray(field.constraints) ? field.constraints : []
              )
              return (
                <div
                  key={`${field.name}-${index}`}
                  className="group relative grid min-h-[36px] grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-white/[0.05] px-2.5 last:border-b-0 hover:bg-white/[0.04]"
                >
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={`${field.name}:target`}
                    style={{ top }}
                    className={HANDLE_CLASS}
                  />
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={`${field.name}:source`}
                    style={{ top }}
                    className={HANDLE_CLASS}
                  />
                  <div className="flex h-full items-center justify-center">
                    <ColumnKeyIcon isPrimary={isPrimary} isForeign={isForeign} />
                  </div>
                  <span className="min-w-0 truncate text-[13px] font-medium leading-tight text-slate-100" title={field.name}>
                    {field.name}
                  </span>
                  <span
                    className="max-w-[9.5rem] shrink-0 truncate text-right font-mono text-[11px] leading-tight text-slate-500"
                    title={field.type}
                  >
                    {field.type}
                  </span>
                </div>
              )
            })
          ) : (
            <p className="px-4 py-4 text-xs text-slate-500">No columns in this table.</p>
          )}
        </div>
        <div
          className={`pointer-events-none absolute bottom-0 left-0 right-2 z-[1] h-8 bg-gradient-to-t from-[#161b26] via-[#161b26]/70 to-transparent transition-opacity duration-200 ${
            showScrollFade ? 'opacity-100' : 'opacity-0'
          }`}
          aria-hidden
        />
      </div>
    </div>
  )
}

const aiNodeTypes: NodeTypes = {
  aiTableNode: AITableNode,
}

function normalizeFlowNodes(result: AISchemaResult | null): Node[] {
  const rawNodes = result?.react_flow_graph?.nodes ?? []
  const sqlText = collectSql(result)
  let sqlColumnMap: Map<string, AIGraphColumn[]> | null = null
  if (sqlText.trim()) {
    const parsed = parseSchemaSQL(sqlText)
    if (parsed?.tables.length) {
      sqlColumnMap = buildSqlColumnsByTableName(parsed.tables, parsed.relationships)
    }
  }

  return rawNodes.map((rawNode, index) => {
    const row = Math.floor(index / 4)
    const col = index % 4
    const fallbackX = 120 + col * 404
    const fallbackY = 80 + row * 300
    const safeId =
      typeof rawNode?.id === 'string' && rawNode.id.trim()
        ? rawNode.id
        : `ai_node_${index + 1}`
    const rawData = (rawNode as { data?: Record<string, unknown> }).data ?? {}
    const label =
      typeof rawData.label === 'string' && rawData.label.trim()
        ? rawData.label
        : safeId
    const graphColumns = parseColumns(rawData)
    const fromSql = sqlColumnMap?.get(normalizeGraphTableLabel(label)) ?? []
    const columns = graphColumns.length > 0 ? graphColumns : fromSql
    const useTableNode = columns.length > 0
    const safeNode: Node = {
      id: safeId,
      position: {
        x: toFiniteNumber(
          (rawNode as { position?: { x?: unknown } }).position?.x,
          fallbackX
        ),
        y: toFiniteNumber(
          (rawNode as { position?: { y?: unknown } }).position?.y,
          fallbackY
        ),
      },
      data: {
        ...(rawData ?? {}),
        label,
        columns,
      },
      type: useTableNode ? 'aiTableNode' : 'default',
    }
    return safeNode
  })
}

function nodeColumnNameSet(node: Node): Set<string> {
  if (node.type !== 'aiTableNode') return new Set()
  const d = node.data as AITableNodeData
  return new Set((d.columns ?? []).map((c) => c.name))
}

function buildTableNameToNodeId(nodes: Node[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const n of nodes) {
    if (n.type !== 'aiTableNode') continue
    const d = n.data as AITableNodeData
    m.set(normalizeGraphTableLabel(d.label), n.id)
  }
  return m
}

function parseHandleColumnName(handleId: string | null | undefined): string | null {
  if (!handleId) return null
  const m = /^([^:]+):(source|target)$/.exec(handleId)
  return m ? m[1] : null
}

function rawEdgeColumnHandlesValid(edge: Edge, nodesById: Map<string, Node>): boolean {
  if (!edge.sourceHandle || !edge.targetHandle) return false
  const sc = parseHandleColumnName(edge.sourceHandle)
  const tc = parseHandleColumnName(edge.targetHandle)
  if (!sc || !tc) return false
  const s = nodesById.get(edge.source)
  const t = nodesById.get(edge.target)
  if (!s || !t) return false
  return nodeColumnNameSet(s).has(sc) && nodeColumnNameSet(t).has(tc)
}

function edgeDedupKey(e: Pick<Edge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>): string {
  return `${e.source}|${e.sourceHandle ?? ''}|${e.target}|${e.targetHandle ?? ''}`
}

type ParsedSqlSchema = NonNullable<ReturnType<typeof parseSchemaSQL>>

function createReferenceEdge(
  sourceNodeId: string,
  targetNodeId: string,
  fkColumn: string,
  referencedColumn: string,
  index: number
): Edge {
  return {
    id: `ref-${sourceNodeId}-${fkColumn}-to-${targetNodeId}-${referencedColumn}-${index}`,
    source: sourceNodeId,
    target: targetNodeId,
    sourceHandle: `${fkColumn}:source`,
    targetHandle: `${referencedColumn}:target`,
    type: 'step',
    animated: false,
    focusable: true,
    label: 'FK',
    labelStyle: {
      fill: '#7dd3fc',
      fontSize: 9,
      fontWeight: 700,
    },
    labelBgStyle: {
      fill: 'rgba(15, 23, 42, 0.94)',
      stroke: 'rgba(56, 189, 248, 0.35)',
      strokeWidth: 1,
    },
    labelBgPadding: [3, 5] as [number, number],
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: '#38bdf8',
      width: 15,
      height: 15,
    },
    style: {
      stroke: '#38bdf8',
      strokeWidth: 1.4,
      strokeOpacity: 0.78,
    },
    interactionWidth: 18,
    className: 'ai-schema-ref-edge',
  }
}

function buildSqlReferenceEdges(nodes: Node[], parsed: ParsedSqlSchema): Edge[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const tableById = new Map(parsed.tables.map((t) => [t.id, t]))
  const nameToNodeId = buildTableNameToNodeId(nodes)
  const out: Edge[] = []
  let idx = 0
  for (const rel of parsed.relationships) {
    const st = tableById.get(rel.sourceTableId)
    const tt = tableById.get(rel.targetTableId)
    if (!st || !tt) continue
    const sc = st.columns.find((c) => c.id === rel.sourceColumnId)
    const tc = tt.columns.find((c) => c.id === rel.targetColumnId)
    if (!sc || !tc) continue
    const sourceNodeId = nameToNodeId.get(normalizeGraphTableLabel(st.name))
    const targetNodeId = nameToNodeId.get(normalizeGraphTableLabel(tt.name))
    if (!sourceNodeId || !targetNodeId) continue
    const sn = nodesById.get(sourceNodeId)
    const tn = nodesById.get(targetNodeId)
    if (!sn || !tn) continue
    if (!nodeColumnNameSet(sn).has(sc.name) || !nodeColumnNameSet(tn).has(tc.name)) continue
    out.push(createReferenceEdge(sourceNodeId, targetNodeId, sc.name, tc.name, idx))
    idx += 1
  }
  return out
}

function mapRawAiEdgesToFlow(result: AISchemaResult, validNodeIds: Set<string>, nodesById: Map<string, Node>): Edge[] {
  const rawEdges = result.react_flow_graph?.edges ?? []
  return rawEdges
    .map((rawEdge, index) => {
      const source =
        typeof rawEdge?.source === 'string' && rawEdge.source.trim()
          ? rawEdge.source
          : ''
      const target =
        typeof rawEdge?.target === 'string' && rawEdge.target.trim()
          ? rawEdge.target
          : ''
      if (!source || !target || !validNodeIds.has(source) || !validNodeIds.has(target)) {
        return null
      }
      const safeId =
        typeof rawEdge?.id === 'string' && rawEdge.id.trim()
          ? rawEdge.id
          : `${source}__${target}__${index + 1}`
      const sourceHandle =
        typeof rawEdge?.sourceHandle === 'string' ? rawEdge.sourceHandle : undefined
      const targetHandle =
        typeof rawEdge?.targetHandle === 'string' ? rawEdge.targetHandle : undefined
      const edge: Edge = {
        id: safeId,
        source,
        target,
        sourceHandle,
        targetHandle,
        label: cardinalityText(rawEdge),
        type: 'step',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#94a3b8',
          width: 17,
          height: 17,
        },
        labelStyle: {
          fill: '#cbd5e1',
          fontSize: 10,
          fontWeight: 600,
        },
        labelBgStyle: {
          fill: 'rgba(22, 27, 38, 0.92)',
          stroke: 'rgba(148, 163, 184, 0.25)',
          strokeWidth: 1,
        },
        style: {
          stroke: '#94a3b8',
          strokeWidth: 1.45,
          strokeOpacity: 0.85,
        },
        animated: false,
        interactionWidth: 16,
      }
      if (sourceHandle && targetHandle && !rawEdgeColumnHandlesValid(edge, nodesById)) {
        return null
      }
      return edge
    })
    .filter((edge): edge is Edge => Boolean(edge))
}

/** Validated AI edges (underlay) + SQL FK column-to-column references (drawn on top). */
function buildMergedFlowEdges(result: AISchemaResult | null, nodes: Node[]): Edge[] {
  if (!result) return []
  const validNodeIds = new Set(nodes.map((n) => n.id))
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const sqlText = collectSql(result)
  const parsed = sqlText.trim() ? parseSchemaSQL(sqlText) : null
  const refEdges = parsed ? buildSqlReferenceEdges(nodes, parsed) : []
  const refKeySet = new Set(refEdges.map((e) => edgeDedupKey(e)))

  const rawMapped = mapRawAiEdgesToFlow(result, validNodeIds, nodesById)
  const hasRefBetween = (a: string, b: string) =>
    refEdges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))

  const rawLayer: Edge[] = []
  const seenRaw = new Set<string>()
  for (const e of rawMapped) {
    const key = edgeDedupKey(e)
    if (refKeySet.has(key) || seenRaw.has(key)) continue
    if (!e.sourceHandle && !e.targetHandle && hasRefBetween(e.source, e.target)) continue
    rawLayer.push(e)
    seenRaw.add(key)
  }
  return [...rawLayer, ...refEdges]
}

export function AISchemaDesigner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const apiKeySetting = useSettingsStore((s) => s.openRouterApiKey)
  const settingsDefaultModel = useSettingsStore((s) => s.aiSchemaDefaultModel)
  const {
    phase,
    milestones,
    activeModel,
    selectedModel,
    qualityMode,
    skipDocs,
    schemaResult,
    error,
    streamBuffer,
    startGeneration,
    updateBuffer,
    setMilestone,
    setPhase,
    setResult,
    setError,
    setQualityMode,
    setSkipDocs,
    setSelectedModel,
    updateIntent,
    setUpdateIntent,
    rotateModel,
    abort,
  } = useAISchemaStore()
  const [intent, setIntent] = useState('')
  const [multiTenant, setMultiTenant] = useState(false)
  const [auditRequired, setAuditRequired] = useState(false)
  const [scaleTier, setScaleTier] = useState<'startup' | 'growth' | 'enterprise'>('growth')
  const [tab, setTab] = useState('sql')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectId, setProjectId] = useState<string>(() => `ai-project-${Date.now()}`)

  useEffect(() => {
    const fromQuery = searchParams.get('projectId')
    if (!fromQuery) return
    const decoded = decodeURIComponent(fromQuery)
    setProjectId(decoded)
    const existing = loadAISchemaProject(decoded)
    if (!existing) return
    setIntent(existing.prompt || '')
    setUpdateIntent(existing.update_prompt || '')
    setResult(existing.schema)
  }, [searchParams, setResult, setUpdateIntent])

  const domain = useMemo(() => detectDomain(intent), [intent])
  const effectiveApiKey = (apiKeySetting || readOpenRouterApiKeyFromEnv()).trim()
  const effectiveModel =
    selectedModel || settingsDefaultModel || OPENROUTER_FREE_MODELS[0]?.id

  const sqlOutput = useMemo(() => collectSql(schemaResult), [schemaResult])

  const snapshotNodes = useMemo(
    () => (schemaResult ? normalizeFlowNodes(schemaResult) : []),
    [schemaResult]
  )

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  useEffect(() => {
    if (!schemaResult) {
      setNodes([])
      setEdges([])
      return
    }
    setNodes(snapshotNodes)
    setEdges(buildMergedFlowEdges(schemaResult, snapshotNodes))
  }, [schemaResult, snapshotNodes])

  useEffect(() => {
    if (snapshotNodes.length === 0) return
    const frame = requestAnimationFrame(() => {
      rfInstance.current?.fitView({ padding: 0.2, maxZoom: 1.15, duration: 320 })
    })
    return () => cancelAnimationFrame(frame)
  }, [schemaResult, snapshotNodes.length])

  const onInit = useCallback((inst: ReactFlowInstance) => {
    rfInstance.current = inst
  }, [])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const columnCatalog = useMemo(() => {
    const rows: Array<{
      id: string
      table: string
      name: string
      type: string
      constraints: string[]
      isPk: boolean
      isFk: boolean
    }> = []
    for (const node of snapshotNodes) {
      if (node.type !== 'aiTableNode') continue
      const d = node.data as AITableNodeData
      const table = d.label
      for (const col of d.columns ?? []) {
        const constraints = Array.isArray(col.constraints) ? col.constraints : []
        const { isPrimary, isForeign } = columnKeyFlags(constraints)
        rows.push({
          id: `${table}.${col.name}`,
          table,
          name: col.name,
          type: col.type,
          constraints,
          isPk: isPrimary,
          isFk: isForeign,
        })
      }
    }
    return rows
  }, [snapshotNodes])

  const columnCatalogTables = useMemo(() => new Set(columnCatalog.map((r) => r.table)).size, [columnCatalog])

  const quickPrompts = [
    'Build a marketplace schema with products, carts, orders, and refunds.',
    'Design a multi-tenant project management schema like Linear.',
    'Create a healthcare EMR schema with appointments and audit logs.',
    'Generate a fintech ledger schema with double-entry transactions.',
  ]

  const generationInProgress =
    phase === 'analyzing' || phase === 'streaming' || phase === 'recovering'

  const persistProject = useCallback(
    (result: AISchemaResult) => {
      const now = new Date().toISOString()
      const existing = loadAISchemaProject(projectId)
      const name =
        String(result?.schema_meta?.project_name || '').trim() ||
        String(result?.schema_meta?.title || '').trim() ||
        existing?.name ||
        'AI Generated Schema'
      saveAISchemaProject({
        id: projectId,
        name,
        description:
          String(result?.schema_meta?.summary || '').trim() ||
          existing?.description ||
          '',
        prompt: intent.trim() || existing?.prompt || '',
        update_prompt: updateIntent.trim(),
        model: activeModel,
        created_at: existing?.created_at || now,
        updated_at: now,
        schema: result,
      })
    },
    [activeModel, intent, projectId, updateIntent]
  )

  const requestGeneration = async (payloadIntent: string, existingSchemaSummary?: string) => {
    if (!payloadIntent.trim()) {
      setError('Describe what you want to design first.')
      return
    }
    if (!effectiveApiKey) {
      setError('OpenRouter API key is missing. Add it in settings or NEXT_PUBLIC_OPENROUTER_API_KEY.')
      return
    }
    const controller = startGeneration(effectiveModel)
    const fallbackChain = buildFallbackChain(effectiveModel)
    let model: string | null = fallbackChain[0] ?? null
    const userMessage = buildUserMessage({
      userIntent: payloadIntent.trim(),
      detectedDomain: detectDomain(payloadIntent),
      scaleTier,
      isMultiTenant: multiTenant ? 'true' : 'false',
      auditRequired: auditRequired ? 'true' : 'false',
      existingSchemaSummary: existingSchemaSummary || 'none',
      conversationHistoryCompressed: '(none)',
      imageBase64Array: 'none',
      pgVersion: '16',
      qualityMode,
    })
    const messageToModel = existingSchemaSummary
      ? buildSchemaUpdateMessage(userMessage, existingSchemaSummary)
      : userMessage
    const systemPrompt = buildSystemPrompt(qualityMode, skipDocs)

    while (model) {
      let localStreamText = ''
      try {
        setPhase('streaming')
        const streamed = await callOpenRouterStream(
          {
            apiKey: effectiveApiKey,
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: messageToModel },
            ],
            reasoningEnabled: true,
            jsonMode: true,
          },
          (chunk) => {
            localStreamText += chunk
            updateBuffer(chunk)
          },
          (milestone) => setMilestone(milestone),
          controller.signal
        )
        const jsonText = extractSchemaJSON(localStreamText || streamed.text)
        const parsed = JSON.parse(jsonText) as AISchemaResult
        setResult(parsed)
        persistProject(parsed)
        setTab('canvas')
        return
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof SchemaRateLimitError) {
          const next = rotateModel(fallbackChain)
          model = next
          if (next) {
            toast.info(`Rate limited on ${activeModel}. Switched to ${next}.`)
            continue
          }
          setError('All free models are currently rate-limited. Try again in a moment.')
          return
        }
        if (err instanceof SchemaParseError) {
          try {
            setPhase('recovering')
            const brokenText = localStreamText || streamBuffer
            const recoveryPrompt = buildRecoveryPrompt(
              userMessage,
              brokenText,
              ['schema_meta', 'sql_blocks', 'react_flow_graph', 'schema_doc']
            )
            const recovered = await callOpenRouterSync({
              apiKey: effectiveApiKey,
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: recoveryPrompt },
              ],
              reasoningEnabled: true,
              jsonMode: true,
            })
            try {
              const recoveredJson = extractSchemaJSON(recovered)
              const parsed = JSON.parse(recoveredJson) as AISchemaResult
              setResult(parsed)
              persistProject(parsed)
              setMilestone('done')
              return
            } catch {
              const repaired = await repairBrokenSchemaJSON({
                apiKey: effectiveApiKey,
                model,
                messages: [],
                brokenJsonText: recovered,
              })
              const repairedJson = extractSchemaJSON(repaired)
              const parsed = JSON.parse(repairedJson) as AISchemaResult
              setResult(parsed)
              persistProject(parsed)
              setMilestone('done')
              return
            }
          } catch (recoveryErr) {
            const message =
              recoveryErr instanceof Error ? recoveryErr.message : 'Recovery failed'
            setError(`Schema JSON recovery failed: ${message}`)
            return
          }
        }
        const message = err instanceof Error ? err.message : 'Generation failed'
        setError(message)
        return
      }
    }
  }

  const generate = async () => requestGeneration(intent)

  const generateUpdate = async () => {
    if (!schemaResult) {
      await requestGeneration(updateIntent)
      return
    }
    await requestGeneration(updateIntent, collectSql(schemaResult))
  }

  const copySql = async () => {
    if (!sqlOutput.trim()) return
    try {
      await navigator.clipboard.writeText(sqlOutput)
      toast.success('SQL copied')
    } catch {
      toast.error('Could not copy SQL')
    }
  }

  const exportJson = async () => {
    if (!schemaResult) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(schemaResult, null, 2))
      toast.success('Schema JSON copied')
    } catch {
      toast.error('Could not copy JSON')
    }
  }

  const saveCurrentProject = () => {
    if (!schemaResult) return
    if (!parseSchemaSQL(sqlOutput)) {
      toast.error('Could not parse generated SQL output.')
      return
    }
    const now = new Date().toISOString()
    const existing = loadAISchemaProject(projectId)
    const name =
      String(schemaResult?.schema_meta?.project_name || '').trim() ||
      String(schemaResult?.schema_meta?.title || '').trim() ||
      existing?.name ||
      'AI Generated Schema'
    saveAISchemaProject({
      id: projectId,
      name,
      description:
        String(schemaResult?.schema_meta?.summary || '').trim() ||
        existing?.description ||
        '',
      prompt: intent.trim() || existing?.prompt || '',
      update_prompt: updateIntent.trim(),
      model: activeModel,
      created_at: existing?.created_at || now,
      updated_at: now,
      schema: schemaResult,
    })
    router.push(aiSchemaViewHref(projectId))
  }

  return (
    <main className="relative h-dvh overflow-hidden bg-slate-950 text-slate-100">
      <div className="absolute left-0 right-0 top-0 z-30 border-b border-slate-700/70 bg-slate-900/85 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-slate-200 hover:bg-slate-800 hover:text-white"
              onClick={() => router.push('/schema-projects')}
              aria-label="Back to projects"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-cyan-300" />
              <span className="text-sm font-semibold">
                {String(schemaResult?.schema_meta?.title || 'AI Schema Designer')}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
              onClick={() => setSettingsOpen((prev) => !prev)}
            >
              <Settings2 className="mr-1 h-4 w-4" />
              Settings
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
              onClick={copySql}
              disabled={!sqlOutput.trim()}
            >
              <Copy className="mr-1 h-4 w-4" />
              Copy SQL
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
              onClick={exportJson}
              disabled={!schemaResult}
            >
              Export JSON
            </Button>
            <Button size="sm" onClick={saveCurrentProject} disabled={!schemaResult}>
              <Database className="mr-1 h-4 w-4" />
              Save Project
            </Button>
          </div>
        </div>
      </div>

      <div className="absolute inset-0 pt-14">
        {nodes.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onInit={onInit}
            nodeTypes={aiNodeTypes}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            selectNodesOnDrag={false}
            panOnScroll
            zoomOnScroll
            minZoom={0.08}
            maxZoom={1.6}
            connectionLineType={ConnectionLineType.Step}
            connectionLineStyle={{ stroke: '#38bdf8', strokeWidth: 1.35 }}
            defaultEdgeOptions={{
              type: 'step',
              style: {
                stroke: '#94a3b8',
                strokeWidth: 1.45,
                strokeLinecap: 'square',
                strokeLinejoin: 'miter',
              },
            }}
            className="h-full w-full bg-[#12151c]"
          >
            <Background color="rgba(148, 163, 184, 0.14)" gap={24} size={1.15} />
            <MiniMap
              pannable
              zoomable
              className="!bg-slate-900/90"
              nodeColor={() => '#e2e8f0'}
              maskColor="rgba(2, 6, 23, 0.7)"
            />
            <Controls className="!bg-slate-900 !text-slate-100" />
          </ReactFlow>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <div className="text-center text-sm text-slate-400">
              {generationInProgress ? 'Generating schema graph...' : 'Generate a schema to view the relationship graph.'}
            </div>
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="pointer-events-auto mx-auto mt-16 max-w-6xl px-4">
          <div className="grid grid-cols-6 gap-2 rounded-xl border border-slate-700/70 bg-slate-900/65 p-3 backdrop-blur">
            {MILESTONE_LABELS.map((item) => (
              <div key={item.key} className="space-y-1">
                <div className={`h-1 rounded-full ${milestones[item.key] ? 'bg-cyan-400' : 'bg-slate-700'}`} />
                <p className="text-[11px] text-slate-300">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showError(error)}

      {!schemaResult && !generationInProgress ? (
        <div className="absolute left-1/2 top-1/2 z-20 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 px-4">
          <Card className="border-slate-700 bg-slate-900/90 shadow-2xl">
            <CardHeader>
              <CardTitle className="text-4xl font-semibold tracking-tight text-slate-100">
                Welcome to Stitch..
              </CardTitle>
              <CardDescription className="text-slate-400">
                Describe your app and generate a full, production-ready PostgreSQL schema.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="What native mobile app shall we design?"
                className="min-h-28 border-slate-700 bg-slate-950 text-slate-100"
              />
              <div className="flex flex-wrap gap-2">
                {quickPrompts.map((prompt) => (
                  <Button
                    key={prompt}
                    type="button"
                    variant="outline"
                    className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                    onClick={() => setIntent(prompt)}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <div className="flex gap-2 text-xs">
                  <Badge variant="secondary" className="bg-slate-800 text-slate-200">
                    Domain: {domain}
                  </Badge>
                  <Badge variant="outline" className="border-slate-600 text-slate-300">
                    Active: {activeModel}
                  </Badge>
                </div>
                <Button onClick={() => void generate()} disabled={generationInProgress}>
                  <Wand2 className="mr-2 h-4 w-4" />
                  Generate
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {generationInProgress ? (
        <div className="absolute bottom-6 left-1/2 z-20 -translate-x-1/2">
          <Button variant="outline" onClick={abort} className="border-slate-600 bg-slate-900 text-slate-100">
            {phase === 'recovering' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
            {phase === 'recovering' ? 'Recovering' : 'Stop generation'}
          </Button>
        </div>
      ) : null}

      {schemaResult ? (
        <div className="absolute bottom-6 left-1/2 z-20 w-full max-w-3xl -translate-x-1/2 px-4">
          <Card className="border-slate-700 bg-slate-900/95 shadow-2xl">
            <CardContent className="space-y-3 p-3">
              <Textarea
                value={updateIntent}
                onChange={(e) => setUpdateIntent(e.target.value)}
                placeholder="Update or create tables - describe what you'd like to change..."
                className="min-h-20 border-slate-700 bg-slate-950 text-slate-100"
              />
              <div className="flex justify-end">
                <Button onClick={() => void generateUpdate()} disabled={generationInProgress || !updateIntent.trim()}>
                  <Send className="mr-2 h-4 w-4" />
                  Apply Update
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <aside
        className={`absolute right-0 top-14 z-20 h-[calc(100%-3.5rem)] border-l border-slate-700/80 bg-slate-900/95 backdrop-blur transition-all duration-300 ${
          settingsOpen ? 'w-[420px]' : 'w-0 overflow-hidden border-l-0'
        }`}
      >
        <div className="h-full p-4">
          <Tabs value={tab} onValueChange={setTab} className="h-full">
            <TabsList className="grid w-full grid-cols-4 bg-slate-800">
              <TabsTrigger value="sql" className="text-xs">
                SQL
              </TabsTrigger>
              <TabsTrigger value="columns" className="gap-1 text-xs">
                <Table2 className="h-3.5 w-3.5 shrink-0 opacity-80" />
                Columns
              </TabsTrigger>
              <TabsTrigger value="docs" className="text-xs">
                Docs
              </TabsTrigger>
              <TabsTrigger value="settings" className="text-xs">
                Settings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="sql" className="h-[calc(100%-3rem)]">
              <div className="h-full overflow-auto rounded-md border border-slate-700 bg-slate-950 p-3">
                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">
                  {sqlOutput || '-- SQL blocks will appear here'}
                </pre>
              </div>
            </TabsContent>
            <TabsContent value="columns" className="h-[calc(100%-3rem)]">
              <div className="flex h-full flex-col gap-2 overflow-hidden rounded-lg border border-slate-800 bg-[#0b1121] shadow-inner">
                <div className="flex shrink-0 items-center justify-between border-b border-slate-800/90 px-3 py-2.5">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Schema columns
                    </p>
                    <p className="text-xs text-slate-400">
                      {columnCatalog.length > 0
                        ? `${columnCatalog.length} column${columnCatalog.length === 1 ? '' : 's'} · ${columnCatalogTables} table${columnCatalogTables === 1 ? '' : 's'}`
                        : 'Generate a schema to list columns'}
                    </p>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {columnCatalog.length > 0 ? (
                    <Table className="text-xs">
                      <TableHeader>
                        <TableRow className="border-slate-800/90 hover:bg-transparent">
                          <TableHead className="sticky top-0 z-10 h-9 min-w-[7rem] bg-slate-900/98 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 backdrop-blur-sm">
                            Table
                          </TableHead>
                          <TableHead className="sticky top-0 z-10 h-9 min-w-[6.5rem] bg-slate-900/98 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 backdrop-blur-sm">
                            Column
                          </TableHead>
                          <TableHead className="sticky top-0 z-10 h-9 min-w-[5.5rem] bg-slate-900/98 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 backdrop-blur-sm">
                            Type
                          </TableHead>
                          <TableHead className="sticky top-0 z-10 h-9 min-w-[4.5rem] bg-slate-900/98 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 backdrop-blur-sm">
                            Keys
                          </TableHead>
                          <TableHead className="sticky top-0 z-10 h-9 min-w-[8rem] bg-slate-900/98 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 backdrop-blur-sm">
                            Constraints
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {columnCatalog.map((row) => (
                          <TableRow
                            key={row.id}
                            className="border-slate-800/80 transition-colors hover:bg-cyan-500/[0.06]"
                          >
                            <TableCell className="max-w-[10rem] px-3 py-2 align-middle font-mono text-[11px] font-medium text-slate-200">
                              <span className="block truncate" title={row.table}>
                                {row.table}
                              </span>
                            </TableCell>
                            <TableCell className="max-w-[11rem] px-3 py-2 align-middle font-medium text-slate-100">
                              <span className="block truncate" title={row.name}>
                                {row.name}
                              </span>
                            </TableCell>
                            <TableCell className="px-3 py-2 align-middle font-mono text-[11px] text-cyan-100/90">
                              <span className="block truncate" title={row.type}>
                                {row.type}
                              </span>
                            </TableCell>
                            <TableCell className="px-2 py-2 align-middle">
                              <div className="flex flex-wrap items-center justify-center gap-1">
                                {row.isPk ? (
                                  <span
                                    className="inline-flex items-center gap-0.5 rounded-md border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-cyan-300"
                                    title="Primary key"
                                  >
                                    <KeyRound className="h-2.5 w-2.5" />
                                    PK
                                  </span>
                                ) : null}
                                {row.isFk ? (
                                  <span
                                    className="inline-flex items-center gap-0.5 rounded-md border border-sky-500/35 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-300"
                                    title="Foreign key"
                                  >
                                    <Link2 className="h-2.5 w-2.5" />
                                    FK
                                  </span>
                                ) : null}
                                {!row.isPk && !row.isFk ? (
                                  <span className="text-[11px] text-slate-600">—</span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="max-w-[14rem] px-3 py-2 align-middle text-slate-400">
                              {row.constraints.length > 0 ? (
                                <span className="line-clamp-2 text-[11px] leading-snug" title={row.constraints.join(', ')}>
                                  {row.constraints.join(', ')}
                                </span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center">
                      <Table2 className="h-8 w-8 text-slate-600" />
                      <p className="text-sm text-slate-400">No column data yet</p>
                      <p className="max-w-xs text-xs text-slate-500">
                        After generation, every table and field appears here in one place.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
            <TabsContent value="docs" className="h-[calc(100%-3rem)]">
              <div className="h-full overflow-auto rounded-md border border-slate-700 bg-slate-950 p-3">
                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">
                  {schemaResult?.schema_doc || 'No docs generated'}
                </pre>
              </div>
            </TabsContent>
            <TabsContent value="settings" className="h-[calc(100%-3rem)] overflow-auto">
              <Card className="border-slate-700 bg-slate-900">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Brain className="h-4 w-4 text-cyan-300" />
                    Generation Settings
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Detected domain</Label>
                    <Input value={domain} readOnly className="border-slate-700 bg-slate-950 text-slate-100" />
                  </div>
                  <div className="space-y-2">
                    <Label>Scale tier</Label>
                    <Select value={scaleTier} onValueChange={(v) => setScaleTier(v as 'startup' | 'growth' | 'enterprise')}>
                      <SelectTrigger className="border-slate-700 bg-slate-950 text-slate-100">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="startup">startup</SelectItem>
                        <SelectItem value="growth">growth</SelectItem>
                        <SelectItem value="enterprise">enterprise</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-center justify-between rounded-md border border-slate-700 p-3">
                      <Label htmlFor="multi-tenant">Multi-tenant</Label>
                      <Switch id="multi-tenant" checked={multiTenant} onCheckedChange={setMultiTenant} />
                    </div>
                    <div className="flex items-center justify-between rounded-md border border-slate-700 p-3">
                      <Label htmlFor="audit-required">Audit required</Label>
                      <Switch id="audit-required" checked={auditRequired} onCheckedChange={setAuditRequired} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Quality mode</Label>
                    <Select value={qualityMode} onValueChange={(v) => setQualityMode(v as QualityMode)}>
                      <SelectTrigger className="border-slate-700 bg-slate-950 text-slate-100">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="full">full</SelectItem>
                        <SelectItem value="fast">fast</SelectItem>
                        <SelectItem value="tables_only">tables_only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="skip-docs"
                      checked={skipDocs}
                      onCheckedChange={(checked) => setSkipDocs(checked === true)}
                    />
                    <Label htmlFor="skip-docs">Skip documentation output</Label>
                  </div>
                  <div className="space-y-2">
                    <Label>OpenRouter free model</Label>
                    <Select value={effectiveModel} onValueChange={setSelectedModel}>
                      <SelectTrigger className="border-slate-700 bg-slate-950 text-slate-100">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPENROUTER_FREE_MODELS.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label} ({m.latencyTier})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Badge variant="secondary" className="font-normal">
                        Active: {activeModel}
                      </Badge>
                      <Badge variant="outline" className="font-normal">
                        Free models only
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </aside>
    </main>
  )
}

function showError(error: string | null) {
  if (!error) return null
  return (
    <div className="absolute left-1/2 top-20 z-40 w-full max-w-xl -translate-x-1/2 px-4">
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Generation failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    </div>
  )
}
