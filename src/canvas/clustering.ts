import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from 'd3'
import { callGeminiSync, type GeminiModelId } from '@/lib/ai-chat-engine'
import { withGeminiLogging } from '@/lib/gemini-logger'
import type { Relationship, Table } from '@/lib/schema-store'
import {
  ERD_TABLE_CARD_WIDTH,
  HEADER_HEIGHT,
  INDEX_BLOCK_HEIGHT,
  ROW_HEIGHT,
  TABLE_CARD_BODY_PADDING_Y,
} from '@/lib/schema-canvas-layout'
import { resolveGeminiApiKey, useSettingsStore } from '@/stores/settings-store'

export type WeightedEdge = { u: string; v: string; w: number }

export type LayoutCluster = {
  id: string
  label: string
  colorHex: string
  tableIds: string[]
  bbox: { x: number; y: number; w: number; h: number }
}

export type ClusterLayoutResult = {
  positions: Map<string, { x: number; y: number }>
  clusters: LayoutCluster[]
}

const CLUSTER_PAD = 48
const CLUSTER_GAP = 200
const FORCE_TICKS = 320
const LOUVAIN_MAX_LEVEL = 12

const DEFAULT_PALETTE = [
  '#6366f1',
  '#14b8a6',
  '#f97316',
  '#ec4899',
  '#84cc16',
  '#8b5cf6',
  '#06b6d4',
  '#eab308',
  '#ef4444',
  '#22c55e',
]

export function buildFkGraph(
  tables: Table[],
  relationships: Relationship[]
): { nodes: string[]; edges: WeightedEdge[] } {
  const nodes = tables.map((t) => t.id)
  const pairMap = new Map<string, number>()
  for (const r of relationships) {
    const a = r.sourceTableId
    const b = r.targetTableId
    if (a === b) continue
    const key = a < b ? `${a}\x00${b}` : `${b}\x00${a}`
    pairMap.set(key, (pairMap.get(key) ?? 0) + 1)
  }
  const edges: WeightedEdge[] = []
  for (const [k, w] of pairMap) {
    const [u, v] = k.split('\x00')
    edges.push({ u, v, w })
  }
  return { nodes, edges }
}

function buildAdjacency(nodes: string[], edges: WeightedEdge[]) {
  const adj = new Map<string, Map<string, number>>()
  for (const id of nodes) adj.set(id, new Map())
  for (const { u, v, w } of edges) {
    adj.get(u)!.set(v, (adj.get(u)!.get(v) ?? 0) + w)
    adj.get(v)!.set(u, (adj.get(v)!.get(u) ?? 0) + w)
  }
  return adj
}

function graphSizeM(adj: Map<string, Map<string, number>>, nodes: string[]): number {
  let s = 0
  for (const u of nodes) {
    for (const [, w] of adj.get(u) ?? []) {
      s += w
    }
  }
  return s / 2
}

function neighborCommunityWeights(
  u: string,
  adj: Map<string, Map<string, number>>,
  node2com: Map<string, number>
): Map<number, number> {
  const m = new Map<number, number>()
  for (const [v, wt] of adj.get(u) ?? []) {
    if (v === u) continue
    const c = node2com.get(v)!
    m.set(c, (m.get(c) ?? 0) + wt)
  }
  return m
}

function oneLevelLouvain(
  nodes: string[],
  adj: Map<string, Map<string, number>>,
  mTotal: number,
  resolution: number
): { node2com: Map<string, number>; improved: boolean } {
  const deg = new Map<string, number>()
  for (const u of nodes) {
    let s = 0
    for (const w of (adj.get(u) ?? new Map()).values()) s += w
    deg.set(u, s)
  }

  const node2com = new Map<string, number>()
  nodes.forEach((u, i) => node2com.set(u, i))

  const Stot = nodes.map((u) => deg.get(u) ?? 0)

  let improved = false
  let moves = 1
  while (moves > 0) {
    moves = 0
    const order = [...nodes]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }

    for (const u of order) {
      const weights2com = neighborCommunityWeights(u, adj, node2com)
      const bestCom = node2com.get(u)!
      const du = deg.get(u) ?? 0

      Stot[bestCom] -= du
      const wCom = weights2com.get(bestCom) ?? 0
      const removeCost =
        -wCom / mTotal +
        (resolution * (Stot[bestCom] * du)) / (2 * mTotal * mTotal)

      let bestGain = 0
      let bestNew = bestCom

      for (const [com, wt] of weights2com) {
        const gain =
          removeCost +
          wt / mTotal -
          (resolution * (Stot[com] * du)) / (2 * mTotal * mTotal)
        if (gain > bestGain + 1e-12) {
          bestGain = gain
          bestNew = com
        }
      }

      Stot[bestNew] += du
      if (bestNew !== node2com.get(u)) {
        node2com.set(u, bestNew)
        improved = true
        moves += 1
      }
    }
  }

  return { node2com, improved }
}

function reindexCommunities(node2com: Map<string, number>): Map<string, number> {
  const uniq = [...new Set(node2com.values())].sort((a, b) => a - b)
  const mapIdx = new Map<number, number>()
  uniq.forEach((c, i) => mapIdx.set(c, i))
  const next = new Map<string, number>()
  for (const [u, c] of node2com) next.set(u, mapIdx.get(c)!)
  return next
}

/** Louvain community detection (undirected weighted), multi-level contraction. */
export function louvainCommunities(
  nodes: string[],
  edges: WeightedEdge[]
): Map<string, number> {
  if (nodes.length === 0) return new Map()
  if (edges.length === 0) {
    const m = new Map<string, number>()
    nodes.forEach((id, i) => m.set(id, i))
    return m
  }

  let curNodes = [...nodes]
  let adj = buildAdjacency(nodes, edges)
  const origToCur = new Map<string, string>()
  for (const u of nodes) origToCur.set(u, u)

  for (let level = 0; level < LOUVAIN_MAX_LEVEL; level += 1) {
    const mTotal = graphSizeM(adj, curNodes)
    if (mTotal <= 0) break

    const { node2com } = oneLevelLouvain(curNodes, adj, mTotal, 1)
    const compact = reindexCommunities(node2com)
    const comCount = new Set(compact.values()).size
    if (comCount >= curNodes.length) break

    const membersByCom = new Map<number, string[]>()
    for (const u of curNodes) {
      const c = compact.get(u)!
      const list = membersByCom.get(c) ?? []
      list.push(u)
      membersByCom.set(c, list)
    }

    const oldToNew = new Map<string, string>()
    const newNodes: string[] = []
    for (const [c, members] of membersByCom) {
      const nn = `§${level}_${c}`
      newNodes.push(nn)
      for (const mem of members) oldToNew.set(mem, nn)
    }

    const newAdj = new Map<string, Map<string, number>>()
    for (const nn of newNodes) newAdj.set(nn, new Map())

    for (const u of curNodes) {
      for (const [v, wt] of adj.get(u) ?? new Map()) {
        if (v <= u) continue
        const nu = oldToNew.get(u)!
        const nv = oldToNew.get(v)!
        if (nu === nv) {
          const row = newAdj.get(nu)!
          row.set(nu, (row.get(nu) ?? 0) + wt)
        } else {
          newAdj.get(nu)!.set(nv, (newAdj.get(nu)!.get(nv) ?? 0) + wt)
          newAdj.get(nv)!.set(nu, (newAdj.get(nv)!.get(nu) ?? 0) + wt)
        }
      }
    }

    for (const orig of nodes) {
      const cur = origToCur.get(orig)!
      origToCur.set(orig, oldToNew.get(cur)!)
    }

    curNodes = newNodes
    adj = newAdj
    if (curNodes.length <= 1) break
  }

  const buckets = new Map<string, string[]>()
  for (const orig of nodes) {
    const sup = origToCur.get(orig)!
    const list = buckets.get(sup) ?? []
    list.push(orig)
    buckets.set(sup, list)
  }
  const keys = [...buckets.keys()].sort()
  const result = new Map<string, number>()
  keys.forEach((sup, i) => {
    for (const orig of buckets.get(sup)!) result.set(orig, i)
  })
  return result
}

export function estimateTableCardHeight(table: Table): number {
  return (
    HEADER_HEIGHT +
    table.columns.length * ROW_HEIGHT +
    (table.indexes && table.indexes.length > 0 ? INDEX_BLOCK_HEIGHT : 0) +
    TABLE_CARD_BODY_PADDING_Y
  )

}

function defaultColors(count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i += 1)
    out.push(DEFAULT_PALETTE[i % DEFAULT_PALETTE.length])
  return out
}

export type GeminiDomainPayload = {
  domain_name: string
  color_hex: string
  tables: string[]
}[]

export function parseGeminiDomainResponse(
  raw: string,
  tableNames: Set<string>
): GeminiDomainPayload | null {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed
  try {
    const parsed = JSON.parse(jsonStr) as { domains?: unknown }
    const domains = parsed.domains
    if (!Array.isArray(domains)) return null
    const out: GeminiDomainPayload = []
    for (const d of domains) {
      if (!d || typeof d !== 'object') continue
      const o = d as Record<string, unknown>
      const name = typeof o.domain_name === 'string' ? o.domain_name : 'Domain'
      const color =
        typeof o.color_hex === 'string' ? o.color_hex : '#6366f1'
      const tables = Array.isArray(o.tables)
        ? o.tables.filter((t): t is string => typeof t === 'string')
        : []
      out.push({
        domain_name: name,
        color_hex: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#6366f1',
        tables,
      })
    }
    const assigned = new Set<string>()
    const cleaned: GeminiDomainPayload = []
    for (const d of out) {
      const names = d.tables
        .map((n) => n.trim())
        .filter((n) => tableNames.has(n) && !assigned.has(n))
      for (const n of names) assigned.add(n)
      if (names.length > 0)
        cleaned.push({ ...d, tables: names })
    }
    for (const n of tableNames) {
      if (!assigned.has(n)) {
        const single = out.find((d) => d.tables.includes(n))
        const label = single?.domain_name ?? 'Other'
        const col = single?.color_hex ?? '#94a3b8'
        cleaned.push({
          domain_name: label,
          color_hex: /^#[0-9A-Fa-f]{6}$/.test(col) ? col : '#94a3b8',
          tables: [n],
        })
      }
    }
    return cleaned.length > 0 ? cleaned : null
  } catch {
    return null
  }
}

export async function fetchSchemaDomainsWithGemini(options: {
  tableNames: string[]
  edges: { from: string; to: string }[]
  signal?: AbortSignal
  model?: GeminiModelId
}): Promise<GeminiDomainPayload | null> {
  const settings = useSettingsStore.getState()
  const apiKey = resolveGeminiApiKey(settings.geminiApiKey)
  if (!apiKey) return null

  const model =
    options.model ?? (settings.defaultAiModel ?? 'gemini-2.5-flash') as GeminiModelId
  const tableSet = new Set(options.tableNames)
  const payload = JSON.stringify({
    tables: options.tableNames.sort(),
    edges: options.edges,
  })

  const system = `You group database tables into logical domains (e.g. Auth, Commerce, Billing).
Return ONLY valid JSON, no markdown. Shape exactly:
{"domains":[{"domain_name":"string","color_hex":"#RRGGBB","tables":["table_name",...]}]}
Rules: Every input table name appears exactly once across all domains. Use readable domain_name and distinct color_hex values.`

  try {
    const text = await withGeminiLogging(
      async () =>
        callGeminiSync(
          model,
          apiKey,
          [{ role: 'user', parts: [{ text: payload }] }],
          system,
          options.signal,
          { maxOutputTokens: 2048 }
        ),
      {
        model,
        featureType: 'schema-cluster-domains',
        endpoint: 'generateContent',
      }
    )
    return parseGeminiDomainResponse(text, tableSet)
  } catch {
    return null
  }
}

type SimNode = SimulationNodeDatum & { id: string; r: number }

function forceLayoutCluster(
  tableIds: string[],
  edgeList: WeightedEdge[],
  width: number,
  heightById: Map<string, number>
): Map<string, { x: number; y: number }> {
  const localIds = [...tableIds]
  const idSet = new Set(localIds)
  const links: { source: string; target: string; value: number }[] = []
  for (const e of edgeList) {
    if (idSet.has(e.u) && idSet.has(e.v)) {
      links.push({ source: e.u, target: e.v, value: e.w })
    }
  }

  const nodes: SimNode[] = localIds.map((id) => {
    const h = heightById.get(id) ?? 120
    return {
      id,
      x: (Math.random() - 0.5) * 40,
      y: (Math.random() - 0.5) * 40,
      r: Math.hypot(width / 2 + 8, h / 2 + 8),
    }
  })

  const sim = forceSimulation(nodes)
    .force(
      'link',
      forceLink<SimNode, { source: string; target: string; value: number }>(links)
        .id((d) => d.id)
        .distance(120)
        .strength(0.85)
    )
    .force('charge', forceManyBody<SimNode>().strength(-520))
    .force('center', forceCenter(0, 0))
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius((d) => d.r)
        .strength(0.9)
    )
    .alphaDecay(0.02)
    .velocityDecay(0.35)

  sim.tick(FORCE_TICKS)
  sim.stop()

  const pos = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    pos.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })
  }
  return pos
}

function bboxForPositions(
  tableIds: string[],
  positions: Map<string, { x: number; y: number }>,
  width: number,
  heightById: Map<string, number>
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of tableIds) {
    const p = positions.get(id) ?? { x: 0, y: 0 }
    const h = heightById.get(id) ?? 100
    const hw = width / 2
    const hh = h / 2
    minX = Math.min(minX, p.x - hw)
    maxX = Math.max(maxX, p.x + hw)
    minY = Math.min(minY, p.y - hh)
    maxY = Math.max(maxY, p.y + hh)
  }
  return {
    x: minX - CLUSTER_PAD,
    y: minY - CLUSTER_PAD,
    w: maxX - minX + 2 * CLUSTER_PAD,
    h: maxY - minY + 2 * CLUSTER_PAD,
  }
}

type ClusterPackRow = {
  id: string
  label: string
  colorHex: string
  tableIds: string[]
  localPos: Map<string, { x: number; y: number }>
  width: number
  heightById: Map<string, number>
}

type PlacedCluster = {
  cluster: LayoutCluster
  localPos: Map<string, { x: number; y: number }>
  originX: number
  originY: number
}

function packClusters(rows: ClusterPackRow[]): PlacedCluster[] {
  const boxes = rows.map((c) => {
    const bb = bboxForPositions(
      c.tableIds,
      c.localPos,
      c.width,
      c.heightById
    )
    return {
      ...c,
      w: bb.w,
      h: bb.h,
      innerBBox: bb,
    }
  })

  const sorted = [...boxes].sort((a, b) => b.w - a.w)
  const placed: PlacedCluster[] = []

  let rowX = 0
  let rowY = 0
  let rowH = 0
  const maxRowWidth = 3200

  for (const b of sorted) {
    if (rowX > 0 && rowX + b.w > maxRowWidth) {
      rowY += rowH + CLUSTER_GAP
      rowX = 0
      rowH = 0
    }
    const originX = rowX
    const originY = rowY
    placed.push({
      cluster: {
        id: b.id,
        label: b.label,
        colorHex: b.colorHex,
        tableIds: b.tableIds,
        bbox: { x: originX, y: originY, w: b.w, h: b.h },
      },
      localPos: b.localPos,
      originX,
      originY,
    })
    rowX += b.w + CLUSTER_GAP
    rowH = Math.max(rowH, b.h)
  }

  return placed
}

export type ComputeClusterLayoutOptions = {
  mode: 'louvain' | 'gemini'
  geminiDomains?: GeminiDomainPayload | null
  signal?: AbortSignal
}

function groupsFromLouvain(
  node2com: Map<string, number>
): Map<number, string[]> {
  const g = new Map<number, string[]>()
  for (const [u, c] of node2com) {
    const list = g.get(c) ?? []
    list.push(u)
    g.set(c, list)
  }
  return g
}

function geminiClusterRows(
  domains: GeminiDomainPayload,
  tableById: Map<string, Table>
): ClusterPackRow[] {
  const nameToId = new Map(
    [...tableById.values()].map((t) => [t.name, t.id] as const)
  )
  const used = new Set<string>()
  const rows: ClusterPackRow[] = []
  domains.forEach((d, i) => {
    const ids = [
      ...new Set(
        d.tables
          .map((n) => nameToId.get(n.trim()))
          .filter((x): x is string => Boolean(x))
      ),
    ]
    ids.forEach((id) => used.add(id))
    if (ids.length === 0) return
    rows.push({
      id: `ai-${i}`,
      label: d.domain_name,
      colorHex: d.color_hex,
      tableIds: ids,
      localPos: new Map(),
      width: ERD_TABLE_CARD_WIDTH,
      heightById: new Map(),
    })
  })
  const orphans: string[] = []
  for (const t of tableById.values()) {
    if (!used.has(t.id)) orphans.push(t.id)
  }
  if (orphans.length > 0) {
    rows.push({
      id: 'ai-other',
      label: 'Other',
      colorHex: '#94a3b8',
      tableIds: orphans,
      localPos: new Map(),
      width: ERD_TABLE_CARD_WIDTH,
      heightById: new Map(),
    })
  }
  return rows
}

export function computeClusterLayout(
  tables: Table[],
  relationships: Relationship[],
  options: ComputeClusterLayoutOptions
): ClusterLayoutResult {
  const { nodes, edges } = buildFkGraph(tables, relationships)
  const tableById = new Map(tables.map((t) => [t.id, t]))
  const width = ERD_TABLE_CARD_WIDTH
  const heightById = new Map(
    tables.map((t) => [t.id, estimateTableCardHeight(t)])
  )

  let clustersRaw: ClusterPackRow[] = []

  if (
    options.mode === 'gemini' &&
    options.geminiDomains &&
    options.geminiDomains.length > 0
  ) {
    clustersRaw = geminiClusterRows(options.geminiDomains, tableById).map(
      (r) => ({
        ...r,
        heightById,
      })
    )
  } else {
    const com = louvainCommunities(nodes, edges)
    const byCom = groupsFromLouvain(com)
    const comIds = [...byCom.keys()].sort((a, b) => a - b)
    const palette = defaultColors(comIds.length)
    clustersRaw = comIds.map((cid, i) => ({
      id: `c-${cid}`,
      label: `Cluster ${i + 1}`,
      colorHex: palette[i]!,
      tableIds: byCom.get(cid) ?? [],
      localPos: new Map(),
      width,
      heightById,
    }))
  }

  const filled: ClusterPackRow[] = clustersRaw
    .filter((c) => c.tableIds.length > 0)
    .map((c) => ({
      ...c,
      localPos: forceLayoutCluster(c.tableIds, edges, width, heightById),
    }))

  const packed = packClusters(filled)
  const positions = new Map<string, { x: number; y: number }>()

  for (const pack of packed) {
    const b = bboxForPositions(
      pack.cluster.tableIds,
      pack.localPos,
      width,
      heightById
    )
    const ox = pack.originX - b.x
    const oy = pack.originY - b.y
    for (const tid of pack.cluster.tableIds) {
      const lp = pack.localPos.get(tid) ?? { x: 0, y: 0 }
      positions.set(tid, {
        x: Math.round(lp.x + ox),
        y: Math.round(lp.y + oy),
      })
    }
  }

  const clusters = packed.map((p) => p.cluster)
  return { positions, clusters }
}
