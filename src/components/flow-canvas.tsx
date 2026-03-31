'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  Background,
  Connection,
  Controls,
  Edge,
  ConnectionLineType,
  MarkerType,
  MiniMap,
  Node,
  NodeTypes,
  ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  StickyNote,
  Image as ImageIcon,
  AlarmClock,
  LayoutGrid,
  LayoutDashboard,
  Search,
  X,
} from 'lucide-react'
import { ClusterBackground } from '@/canvas/ClusterBackground'
import {
  computeClusterLayout,
  fetchSchemaDomainsWithGemini,
  type LayoutCluster,
} from '@/canvas/clustering'
import { useShallow } from 'zustand/react/shallow'
import { useSchemaStore } from '@/lib/schema-store'
import {
  COLUMN_GAP,
  ERD_TABLE_CARD_WIDTH,
  GRID_SIZE,
  HEADER_HEIGHT,
  INDEX_BLOCK_HEIGHT,
  ROW_GAP,
  ROW_HEIGHT,
  TABLE_CARD_BODY_PADDING_Y,
} from '@/lib/schema-canvas-layout'
import { TableNode } from '@/components/table-node'
import { NoteNode } from '@/components/note-node'
import { ImageNode } from '@/components/image-node'
import { CronNode } from '@/components/cron-node'
import { FunctionNode } from '@/components/function-node'
import { TriggerNode } from '@/components/trigger-node'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'

const nodeTypes: NodeTypes = {
  tableNode: TableNode,
  noteNode: NoteNode,
  imageNode: ImageNode,
  cronNode: CronNode,
  functionNode: FunctionNode,
  triggerNode: TriggerNode,
  clusterBackground: ClusterBackground,
}

const REL_EDGE_STORAGE_KEY = 'schema-canvas-rel-edge-type'

function createCanvasItemId(): string {
  return `canvas-${Date.now()}`
}

function stripHandleId(handle?: string | null) {
  if (!handle) return null
  return handle.replace(/:(source|target)$/, '')
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function relationshipLabel(type: string) {
  switch (type) {
    case 'one-to-one':
      return '1..1'
    case 'many-to-many':
      return '*..*'
    default:
      return '1..*'
  }
}

const CLUSTER_ANIM_MS = 600

function easeInOutQuad(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

type ClusterLayoutSnapshot = {
  tables: { id: string; x: number; y: number }[]
  functions: { id: string; x: number; y: number }[]
  triggers: { id: string; x: number; y: number }[]
}

export function FlowCanvas() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)
  const layoutRetryRef = useRef(0)
  const autoLayoutKeyRef = useRef<string | null>(null)
  const nodesSigRef = useRef('')
  const edgesSigRef = useRef('')
  const clusterSnapshotRef = useRef<ClusterLayoutSnapshot | null>(null)

  const {
    tables,
    relationships,
    functions,
    triggers,
    canvasItems,
    selectedRelationshipId,
    updateTable,
    setTables,
    addRelationship,
    updateRelationship,
    deleteRelationship,
    setSelectedRelationshipId,
    addCanvasItem,
    updateCanvasItem,
    updateFunction,
    updateTrigger,
    setFunctions,
    setTriggers,
    setSelectedTableId,
  } = useSchemaStore(
    useShallow((s) => ({
      tables: s.tables,
      relationships: s.relationships,
      functions: s.functions,
      triggers: s.triggers,
      canvasItems: s.canvasItems,
      selectedRelationshipId: s.selectedRelationshipId,
      updateTable: s.updateTable,
      setTables: s.setTables,
      addRelationship: s.addRelationship,
      updateRelationship: s.updateRelationship,
      deleteRelationship: s.deleteRelationship,
      setSelectedRelationshipId: s.setSelectedRelationshipId,
      addCanvasItem: s.addCanvasItem,
      updateCanvasItem: s.updateCanvasItem,
      updateFunction: s.updateFunction,
      updateTrigger: s.updateTrigger,
      setFunctions: s.setFunctions,
      setTriggers: s.setTriggers,
      setSelectedTableId: s.setSelectedTableId,
    }))
  )

  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [clusterGrouped, setClusterGrouped] = useState(false)
  const [clusterLayouts, setClusterLayouts] = useState<LayoutCluster[]>([])
  const [clusterLayoutBusy, setClusterLayoutBusy] = useState(false)
  const [clusterMode, setClusterMode] = useState<'heuristic' | 'gemini'>(
    'heuristic'
  )
  const [clusterAnimPositions, setClusterAnimPositions] = useState<Map<
    string,
    { x: number; y: number }
  > | null>(null)
  const [relEdgeType, setRelEdgeType] = useState<'step' | 'smoothstep'>(() => {
    if (typeof window === 'undefined') return 'smoothstep'
    const v = window.sessionStorage.getItem(REL_EDGE_STORAGE_KEY)
    return v === 'step' ? 'step' : 'smoothstep'
  })

  const persistRelEdgeType = useCallback((t: 'step' | 'smoothstep') => {
    setRelEdgeType(t)
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(REL_EDGE_STORAGE_KEY, t)
    }
  }, [])

  const maxX = useMemo(
    () => tables.reduce((acc, table) => Math.max(acc, table.x), 0),
    [tables]
  )
  const baseX = maxX + 360

  const nodes: Node[] = useMemo(() => {
    const clusterBgNodes: Node[] = clusterGrouped
      ? clusterLayouts.map((c) => ({
          id: `cluster-bg:${c.id}`,
          type: 'clusterBackground',
          position: { x: c.bbox.x, y: c.bbox.y },
          zIndex: -1000,
          draggable: false,
          selectable: false,
          focusable: false,
          data: {
            label: c.label,
            colorHex: c.colorHex,
          },
          style: {
            width: c.bbox.w,
            height: c.bbox.h,
          },
        }))
      : []

    const tableNodes: Node[] = tables.map((table) => ({
      id: table.id,
      type: 'tableNode',
      position:
        clusterAnimPositions?.get(table.id) ?? { x: table.x, y: table.y },
      className: 'transition-transform duration-300 ease-out',
      data: {
        tableName: table.name,
        tableId: table.id,
        columns: table.columns.map((col) => ({
          id: col.id,
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          isPrimaryKey: col.isPrimaryKey,
          isUnique: col.isUnique,
        })),
        indexes: table.indexes ?? [],
      },
    }))

    const functionNodes: Node[] = functions.map((fn, index) => {
      const hasPosition = (fn.x ?? 0) !== 0 || (fn.y ?? 0) !== 0
      const position = hasPosition
        ? { x: fn.x ?? baseX, y: fn.y ?? 120 + index * 120 }
        : { x: baseX, y: 120 + index * 140 }
      return {
        id: `function:${fn.id}`,
        type: 'functionNode',
        position,
        className: 'transition-transform duration-300 ease-out',
        data: {
          id: fn.id,
          name: fn.name,
          language: fn.language,
          returns: fn.returns,
          definition: fn.definition,
        },
      }
    })

    const triggerNodes: Node[] = triggers.map((trg, index) => {
      const hasPosition = (trg.x ?? 0) !== 0 || (trg.y ?? 0) !== 0
      const position = hasPosition
        ? { x: trg.x ?? baseX + 260, y: trg.y ?? 120 + index * 120 }
        : { x: baseX + 260, y: 120 + index * 140 }
      const table = tables.find((t) => t.id === trg.tableId)
      return {
        id: `trigger:${trg.id}`,
        type: 'triggerNode',
        position,
        className: 'transition-transform duration-300 ease-out',
        data: {
          id: trg.id,
          name: trg.name,
          tableName: table?.name,
          functionName: trg.functionName,
          timing: trg.timing,
          events: trg.events,
        },
      }
    })

    const canvasNodes: Node[] = canvasItems.map((item) => {
      const type =
        item.kind === 'image'
          ? 'imageNode'
          : item.kind === 'cron'
            ? 'cronNode'
            : 'noteNode'
      return {
        id: `canvas:${item.id}`,
        type,
        position: { x: item.x, y: item.y },
        className: 'transition-transform duration-300 ease-out',
        data: {
          id: item.id,
          text: item.text,
          imageUrl: item.imageUrl,
          schedule: item.schedule,
          task: item.task,
        },
      }
    })

    return [
      ...clusterBgNodes,
      ...tableNodes,
      ...functionNodes,
      ...triggerNodes,
      ...canvasNodes,
    ]
  }, [
    tables,
    functions,
    triggers,
    canvasItems,
    baseX,
    clusterGrouped,
    clusterLayouts,
    clusterAnimPositions,
  ])

  const edges: Edge[] = useMemo(() => {
    const relationEdges = relationships.map((rel) => ({
      id: rel.id,
      source: rel.sourceTableId,
      target: rel.targetTableId,
      sourceHandle: `${rel.sourceColumnId}:source`,
      targetHandle: `${rel.targetColumnId}:target`,
      type: relEdgeType,
      className: 'schema-edge schema-edge-rel',
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'var(--primary)',
      },
      animated: rel.id === selectedRelationshipId,
      label: relationshipLabel(rel.type),
      labelBgStyle: {
        fill: 'color-mix(in oklch, var(--background) 85%, transparent)',
        fillOpacity: 0.92,
        stroke: 'var(--border)',
        strokeWidth: 1,
      },
      labelStyle: {
        fill: 'var(--foreground)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
      },
      style: {
        stroke: 'var(--primary)',
        strokeOpacity: rel.id === selectedRelationshipId ? 1 : 0.7,
        strokeWidth: rel.id === selectedRelationshipId ? 2.6 : 2.2,
      },
    }))

    const triggerEdges: Edge[] = triggers.map((trg) => ({
      id: `trigger-edge:${trg.id}`,
      source: `trigger:${trg.id}`,
      target: trg.tableId,
      type: 'step',
      selectable: false,
      className: 'schema-edge schema-edge-muted',
      style: {
        stroke: 'var(--muted-foreground)',
        strokeDasharray: '4 4',
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'var(--muted-foreground)',
      },
    }))

    const functionByName = new Map(
      functions.map((fn) => [fn.name.toLowerCase(), fn.id])
    )
    const triggerFunctionEdges: Edge[] = triggers
      .map((trg) => {
        const fnId = functionByName.get(trg.functionName.toLowerCase())
        if (!fnId) return null
        return {
          id: `trigger-fn:${trg.id}`,
          source: `trigger:${trg.id}`,
          target: `function:${fnId}`,
          type: 'step',
          selectable: false,
          className: 'schema-edge schema-edge-muted',
          style: {
            stroke: 'var(--muted-foreground)',
            strokeDasharray: '2 4',
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: 'var(--muted-foreground)',
          },
        } as Edge
      })
      .filter(Boolean) as Edge[]

    return [...relationEdges, ...triggerEdges, ...triggerFunctionEdges]
  }, [
    relationships,
    triggers,
    functions,
    selectedRelationshipId,
    relEdgeType,
  ])

  const [flowNodes, setNodes, onNodesChange] = useNodesState(nodes)
  const [flowEdges, setEdges, onEdgesChange] = useEdgesState(edges)

  const nodesSignature = useMemo(
    () =>
      JSON.stringify(
        nodes.map((n) => ({
          i: n.id,
          p: n.position,
          t: n.type,
          d: n.data,
        }))
      ),
    [nodes]
  )

  const edgesSignature = useMemo(
    () =>
      JSON.stringify(
        edges.map((e) => ({
          i: e.id,
          s: e.source,
          t: e.target,
          ty: e.type,
          sh: e.sourceHandle,
          th: e.targetHandle,
          a: e.animated,
        }))
      ),
    [edges]
  )

  useEffect(() => {
    if (nodesSignature === nodesSigRef.current) return
    nodesSigRef.current = nodesSignature
    setNodes(nodes)
  }, [nodes, nodesSignature, setNodes])

  useEffect(() => {
    if (edgesSignature === edgesSigRef.current) return
    edgesSigRef.current = edgesSignature
    setEdges(edges)
  }, [edges, edgesSignature, setEdges])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      const sourceCol = stripHandleId(connection.sourceHandle)
      const targetCol = stripHandleId(connection.targetHandle)
      if (!sourceCol || !targetCol) return

      const exists = relationships.find(
        (rel) =>
          rel.sourceColumnId === sourceCol && rel.targetColumnId === targetCol
      )
      if (exists) return

      const targetTable = tables.find((t) => t.id === connection.target)
      const targetColumn = targetTable?.columns.find((c) => c.id === targetCol)
      const relType =
        targetColumn?.isUnique || targetColumn?.isPrimaryKey
          ? 'one-to-one'
          : 'one-to-many'

      addRelationship({
        id: `rel-${sourceCol}-${targetCol}`,
        sourceTableId: connection.source,
        sourceColumnId: sourceCol,
        targetTableId: connection.target,
        targetColumnId: targetCol,
        type: relType,
      })
    },
    [addRelationship, relationships, tables]
  )

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === 'tableNode') {
        updateTable(node.id, {
          x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
        })
        return
      }
      if (node.type === 'noteNode' || node.type === 'imageNode' || node.type === 'cronNode') {
        const id = node.id.replace('canvas:', '')
        updateCanvasItem(id, {
          x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
        })
        return
      }
      if (node.type === 'functionNode') {
        const id = node.id.replace('function:', '')
        updateFunction(id, {
          x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
        })
        return
      }
      if (node.type === 'triggerNode') {
        const id = node.id.replace('trigger:', '')
        updateTrigger(id, {
          x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
        })
      }
    },
    [updateTable, updateCanvasItem, updateFunction, updateTrigger]
  )

  const getNodeHeight = useCallback(
    (tableId: string, fallback: number) => {
      const node = flowNodes.find((n) => n.id === tableId)
      const measured = node?.height
      if (typeof measured === 'number' && measured > 0) return measured
      return fallback
    },
    [flowNodes]
  )

  const autoLayout = useCallback(function schemaAutoLayout() {
    if (tables.length === 0) return

    const missingSize = tables.some((table) => {
      const node = flowNodes.find((n) => n.id === table.id)
      return !node || !node.height
    })
    if (missingSize && layoutRetryRef.current < 2) {
      layoutRetryRef.current += 1
      requestAnimationFrame(() => {
        schemaAutoLayout()
      })
      return
    }
    layoutRetryRef.current = 0

    const tableMap = new Map(tables.map((t) => [t.id, t]))
    const heightById = new Map<string, number>()
    const snap = (value: number) =>
      Math.round(value / GRID_SIZE) * GRID_SIZE
    const estimateHeight = (table: (typeof tables)[number]) =>
      HEADER_HEIGHT +
      table.columns.length * ROW_HEIGHT +
      (table.indexes && table.indexes.length > 0 ? INDEX_BLOCK_HEIGHT : 0) +
      TABLE_CARD_BODY_PADDING_Y
    tables.forEach((table) => {
      heightById.set(
        table.id,
        getNodeHeight(table.id, estimateHeight(table))
      )
    })
    const childrenByParent = new Map<string, string[]>()
    const parentsByChild = new Map<string, string[]>()
    const indegree = new Map<string, number>()
    tables.forEach((t) => indegree.set(t.id, 0))

    relationships.forEach((rel) => {
      const parent = rel.targetTableId
      const child = rel.sourceTableId
      childrenByParent.set(parent, [
        ...(childrenByParent.get(parent) ?? []),
        child,
      ])
      parentsByChild.set(child, [
        ...(parentsByChild.get(child) ?? []),
        parent,
      ])
      indegree.set(child, (indegree.get(child) ?? 0) + 1)
    })

    const levels = new Map<string, number>()
    tables.forEach((t) => levels.set(t.id, 0))
    const queue: string[] = []
    tables.forEach((t) => {
      if ((indegree.get(t.id) ?? 0) === 0) {
        queue.push(t.id)
      }
    })
    const topo: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) break
      topo.push(current)
      const children = childrenByParent.get(current) ?? []
      children.forEach((child) => {
        indegree.set(child, (indegree.get(child) ?? 0) - 1)
        if ((indegree.get(child) ?? 0) === 0) {
          queue.push(child)
        }
      })
    }
    if (topo.length === 0 && tables.length > 0) {
      topo.push(tables[0].id)
    }
    topo.forEach((current) => {
      const currentLevel = levels.get(current) ?? 0
      const children = childrenByParent.get(current) ?? []
      children.forEach((child) => {
        const nextLevel = currentLevel + 1
        if ((levels.get(child) ?? -1) < nextLevel) {
          levels.set(child, nextLevel)
        }
      })
    })

    // stabilize cycles
    for (let pass = 0; pass < tables.length; pass += 1) {
      relationships.forEach((rel) => {
        const parent = rel.targetTableId
        const child = rel.sourceTableId
        const parentLevel = levels.get(parent) ?? 0
        const childLevel = levels.get(child) ?? 0
        if (childLevel <= parentLevel) {
          levels.set(child, parentLevel + 1)
        }
      })
    }

    const grouped = new Map<number, typeof tables>()
    tables.forEach((t) => {
      const lvl = levels.get(t.id) ?? 0
      const list = grouped.get(lvl) ?? []
      list.push(t)
      grouped.set(lvl, list)
    })

    const levelKeys = Array.from(grouped.keys()).sort((a, b) => a - b)
    const startX = 120
    const startY = 120

    const orderIndex = new Map<string, number>()
    const positionById = new Map<string, { x: number; y: number }>()

    levelKeys.forEach((level) => {
      const list = grouped.get(level) ?? []
      if (list.length === 0) return

      const alphabetic = [...list].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      const fallbackCenters = new Map<string, number>()
      let fallbackCursor = startY
      alphabetic.forEach((table) => {
        const height = heightById.get(table.id) ?? 0
        fallbackCenters.set(table.id, fallbackCursor + height / 2)
        fallbackCursor += height + ROW_GAP
      })

      const idealCenters = new Map<string, number>()
      list.forEach((table) => {
        const parents = parentsByChild.get(table.id) ?? []
        const parentCenters = parents
          .map((id) => {
            const pos = positionById.get(id)
            if (!pos) return null
            const height = heightById.get(id) ?? 0
            return pos.y + height / 2
          })
          .filter((value): value is number => typeof value === 'number')
        const ideal =
          parentCenters.length > 0
            ? parentCenters.reduce((acc, val) => acc + val, 0) /
              parentCenters.length
            : (fallbackCenters.get(table.id) ?? startY)
        idealCenters.set(table.id, ideal)
      })

      const prevIndex = new Map(orderIndex)
      const sorted = [...list].sort((a, b) => {
        const idealA = idealCenters.get(a.id) ?? 0
        const idealB = idealCenters.get(b.id) ?? 0
        if (Math.abs(idealA - idealB) > 6) return idealA - idealB
        const parentsA = parentsByChild.get(a.id) ?? []
        const parentsB = parentsByChild.get(b.id) ?? []
        const scoreA =
          parentsA.reduce((acc, id) => acc + (prevIndex.get(id) ?? 0), 0) /
            Math.max(1, parentsA.length) || 0
        const scoreB =
          parentsB.reduce((acc, id) => acc + (prevIndex.get(id) ?? 0), 0) /
            Math.max(1, parentsB.length) || 0
        if (scoreA !== scoreB) return scoreA - scoreB
        return a.name.localeCompare(b.name)
      })

      const placed = sorted.map((table) => {
        const height = heightById.get(table.id) ?? 0
        const idealCenter = idealCenters.get(table.id) ?? startY + height / 2
        return { table, height, idealCenter, top: 0 }
      })

      let cursorY = startY
      placed.forEach((item) => {
        const desiredTop = item.idealCenter - item.height / 2
        const top = Math.max(desiredTop, cursorY)
        item.top = top
        cursorY = top + item.height + ROW_GAP
      })

      if (placed.length > 1) {
        const deltas = placed.map(
          (item) => item.idealCenter - (item.top + item.height / 2)
        )
        let shift = median(deltas)
        const minTop = Math.min(...placed.map((item) => item.top))
        if (minTop + shift < startY) {
          shift = startY - minTop
        }
        if (Number.isFinite(shift) && Math.abs(shift) > 1) {
          placed.forEach((item) => {
            item.top += shift
          })
          let clampCursor = startY
          placed.forEach((item) => {
            if (item.top < clampCursor) item.top = clampCursor
            clampCursor = item.top + item.height + ROW_GAP
          })
        }
      }

      placed.forEach((item, idx) => {
        const rawX = startX + level * COLUMN_GAP
        const rawY = item.top
        positionById.set(item.table.id, {
          x: snap(rawX),
          y: snap(rawY),
        })
        orderIndex.set(item.table.id, idx)
      })
    })

    const nextTables = tables.map((table) => {
      const pos = positionById.get(table.id)
      return pos ? { ...table, ...pos } : table
    })
    setTables(nextTables)

    const rightEdge =
      Math.round(
        (startX + (levelKeys.length + 0.5) * COLUMN_GAP) / GRID_SIZE
      ) * GRID_SIZE
    setFunctions(
      functions.map((fn, index) => ({
        ...fn,
        x: rightEdge,
        y: Math.round((startY + index * 120) / GRID_SIZE) * GRID_SIZE,
      }))
    )

    const triggersByTable = new Map<string, number>()
    setTriggers(
      triggers.map((trg) => {
        const tablePos = positionById.get(trg.tableId)
        const tableFallback = tableMap.get(trg.tableId)
        if (!tablePos && !tableFallback) return trg
        const baseX = tablePos?.x ?? tableFallback?.x ?? 0
        const baseY = tablePos?.y ?? tableFallback?.y ?? 0
        const offset = triggersByTable.get(trg.tableId) ?? 0
        triggersByTable.set(trg.tableId, offset + 1)
        const rawX = baseX + 240
        const rawY = baseY - 60 - offset * 60
        return {
          ...trg,
          x: Math.round(rawX / GRID_SIZE) * GRID_SIZE,
          y: Math.round(rawY / GRID_SIZE) * GRID_SIZE,
        }
      })
    )

    requestAnimationFrame(() => {
      reactFlowRef.current?.fitView({ padding: 0.2, duration: 500 })
    })
  }, [
    tables,
    relationships,
    functions,
    triggers,
    setTables,
    setFunctions,
    setTriggers,
    getNodeHeight,
    flowNodes,
  ])

  const applySmartCluster = useCallback(async () => {
    if (tables.length === 0 || clusterGrouped) return
    setClusterLayoutBusy(true)
    clusterSnapshotRef.current = {
      tables: tables.map((t) => ({ id: t.id, x: t.x, y: t.y })),
      functions: functions.map((f) => ({
        id: f.id,
        x: f.x ?? 0,
        y: f.y ?? 0,
      })),
      triggers: triggers.map((tr) => ({
        id: tr.id,
        x: tr.x ?? 0,
        y: tr.y ?? 0,
      })),
    }
    try {
      let geminiDomains:
        | Awaited<ReturnType<typeof fetchSchemaDomainsWithGemini>>
        | null = null
      if (clusterMode === 'gemini') {
        const nameById = new Map(tables.map((t) => [t.id, t.name] as const))
        geminiDomains = await fetchSchemaDomainsWithGemini({
          tableNames: [...new Set(tables.map((t) => t.name))].sort(),
          edges: relationships
            .map((r) => ({
              from: nameById.get(r.sourceTableId) ?? '',
              to: nameById.get(r.targetTableId) ?? '',
            }))
            .filter((e) => e.from && e.to),
        })
      }
      const useGemini =
        clusterMode === 'gemini' &&
        geminiDomains != null &&
        geminiDomains.length > 0
      const result = computeClusterLayout(tables, relationships, {
        mode: useGemini ? 'gemini' : 'louvain',
        geminiDomains,
      })
      const fromPos = new Map(
        tables.map((t) => [t.id, { x: t.x, y: t.y }] as const)
      )
      const toPos = result.positions

      setClusterLayouts(result.clusters)
      setClusterGrouped(true)
      requestAnimationFrame(() => {
        reactFlowRef.current?.fitView({
          padding: 0.2,
          duration: CLUSTER_ANIM_MS,
        })
      })

      const snap = (v: number) =>
        Math.round(v / GRID_SIZE) * GRID_SIZE
      const start = performance.now()
      const tablesSnapshot = tables
      const functionsSnapshot = functions
      const triggersSnapshot = triggers

      const step = (now: number) => {
        const t = Math.min(1, (now - start) / CLUSTER_ANIM_MS)
        const k = easeInOutQuad(t)
        const m = new Map<string, { x: number; y: number }>()
        for (const table of tablesSnapshot) {
          const a = fromPos.get(table.id)
          const b = toPos.get(table.id)
          if (!a || !b) continue
          m.set(table.id, {
            x: a.x + (b.x - a.x) * k,
            y: a.y + (b.y - a.y) * k,
          })
        }
        setClusterAnimPositions(m)
        if (t < 1) {
          requestAnimationFrame(step)
        } else {
          setClusterAnimPositions(null)
          const nextTables = tablesSnapshot.map((table) => {
            const p = toPos.get(table.id)
            if (!p) return table
            return { ...table, x: snap(p.x), y: snap(p.y) }
          })
          setTables(nextTables)

          const positionById = new Map(
            nextTables.map((tt) => [tt.id, { x: tt.x, y: tt.y }] as const)
          )
          const tableMap = new Map(nextTables.map((tt) => [tt.id, tt] as const))
          const maxTableX = nextTables.reduce(
            (acc, tt) => Math.max(acc, tt.x + ERD_TABLE_CARD_WIDTH),
            0
          )
          const rightEdge =
            Math.round((maxTableX + 48) / GRID_SIZE) * GRID_SIZE
          setFunctions(
            functionsSnapshot.map((fn, index) => ({
              ...fn,
              x: rightEdge,
              y: Math.round((120 + index * 120) / GRID_SIZE) * GRID_SIZE,
            }))
          )
          const triggersByTable = new Map<string, number>()
          setTriggers(
            triggersSnapshot.map((trg) => {
              const tablePos = positionById.get(trg.tableId)
              const tableFallback = tableMap.get(trg.tableId)
              if (!tablePos && !tableFallback) return trg
              const baseX = tablePos?.x ?? tableFallback?.x ?? 0
              const baseY = tablePos?.y ?? tableFallback?.y ?? 0
              const offset = triggersByTable.get(trg.tableId) ?? 0
              triggersByTable.set(trg.tableId, offset + 1)
              const rawX = baseX + 240
              const rawY = baseY - 60 - offset * 60
              return {
                ...trg,
                x: Math.round(rawX / GRID_SIZE) * GRID_SIZE,
                y: Math.round(rawY / GRID_SIZE) * GRID_SIZE,
              }
            })
          )
          setClusterLayoutBusy(false)
          requestAnimationFrame(() => {
            reactFlowRef.current?.fitView({ padding: 0.2, duration: 400 })
          })
        }
      }
      requestAnimationFrame(step)
    } catch {
      clusterSnapshotRef.current = null
      setClusterGrouped(false)
      setClusterLayouts([])
      setClusterAnimPositions(null)
      setClusterLayoutBusy(false)
    }
  }, [
    tables,
    relationships,
    functions,
    triggers,
    clusterGrouped,
    clusterMode,
    setTables,
    setFunctions,
    setTriggers,
  ])

  const ungroupSmartClusters = useCallback(() => {
    const snap = clusterSnapshotRef.current
    setClusterAnimPositions(null)
    if (!snap) {
      setClusterGrouped(false)
      setClusterLayouts([])
      return
    }
    setTables(
      tables.map((t) => {
        const s = snap.tables.find((x) => x.id === t.id)
        return s ? { ...t, x: s.x, y: s.y } : t
      })
    )
    setFunctions(
      functions.map((f) => {
        const s = snap.functions.find((x) => x.id === f.id)
        return s ? { ...f, x: s.x, y: s.y } : f
      })
    )
    setTriggers(
      triggers.map((tr) => {
        const s = snap.triggers.find((x) => x.id === tr.id)
        return s ? { ...tr, x: s.x, y: s.y } : tr
      })
    )
    clusterSnapshotRef.current = null
    setClusterGrouped(false)
    setClusterLayouts([])
    requestAnimationFrame(() =>
      reactFlowRef.current?.fitView({ padding: 0.2, duration: 400 })
    )
  }, [tables, functions, triggers, setTables, setFunctions, setTriggers])

  useEffect(() => {
    if (clusterGrouped) return
    const key = `${tables.length}-${relationships.length}`
    if (autoLayoutKeyRef.current === key) return
    const xs = tables.map((t) => t.x)
    const ys = tables.map((t) => t.y)
    if (xs.length === 0 || ys.length === 0) return
    const width = Math.max(...xs) - Math.min(...xs)
    const height = Math.max(...ys) - Math.min(...ys)
    const isCollapsed = width < 200 || height < 200
    const hasStacked = tables.some(
      (t) =>
        tables.filter((o) => o.id !== t.id && o.x === t.x && o.y === t.y)
          .length > 0
    )
    if (isCollapsed || hasStacked) {
      autoLayoutKeyRef.current = key
      requestAnimationFrame(() => autoLayout())
    }
  }, [tables, relationships, autoLayout, clusterGrouped])

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      if (!edge.id.startsWith('trigger-edge')) {
        setSelectedRelationshipId(edge.id)
        setInspectorOpen(true)
      }
    },
    [setSelectedRelationshipId]
  )

  const addCanvas = useCallback(
    (kind: 'note' | 'image' | 'cron') => {
      const wrapper = wrapperRef.current
      const instance = reactFlowRef.current
      if (!wrapper || !instance) return
      const bounds = wrapper.getBoundingClientRect()
      const position = instance.project({
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      })
      const id = createCanvasItemId()
      addCanvasItem({
        id,
        kind,
        x: position.x,
        y: position.y,
        text: kind === 'note' ? 'New note' : undefined,
        imageUrl: kind === 'image' ? '' : undefined,
        schedule: kind === 'cron' ? '0 0 * * *' : undefined,
        task: kind === 'cron' ? 'Nightly job' : undefined,
      })
    },
    [addCanvasItem]
  )

  const selectedRelationship = relationships.find(
    (rel) => rel.id === selectedRelationshipId
  )

  const sortedTables = useMemo(
    () => [...tables].sort((a, b) => a.name.localeCompare(b.name)),
    [tables]
  )

  useEffect(() => {
    if (!inspectorOpen || !selectedRelationshipId) return
    if (!relationships.some((r) => r.id === selectedRelationshipId)) {
      setInspectorOpen(false)
      setSelectedRelationshipId(null)
    }
  }, [
    inspectorOpen,
    selectedRelationshipId,
    relationships,
    setSelectedRelationshipId,
  ])

  const handleJumpToTable = useCallback(
    (tableId: string) => {
      setSelectedTableId(tableId)
      setJumpOpen(false)
      requestAnimationFrame(() => {
        reactFlowRef.current?.fitView({
          nodes: [{ id: tableId }],
          duration: 360,
          padding: 0.28,
          maxZoom: 1.35,
        })
      })
    },
    [setSelectedTableId]
  )

  return (
    <div ref={wrapperRef} className="h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => {
          setSelectedRelationshipId(null)
          setInspectorOpen(false)
        }}
        snapToGrid
        snapGrid={[GRID_SIZE, GRID_SIZE]}
        connectionLineType={
          relEdgeType === 'step'
            ? ConnectionLineType.Step
            : ConnectionLineType.SmoothStep
        }
        connectionLineStyle={{
          stroke: 'var(--primary)',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
        }}
        defaultEdgeOptions={{
          style: { strokeLinecap: 'round', strokeLinejoin: 'round' },
        }}
        onlyRenderVisibleElements
        elevateNodesOnSelect
        minZoom={0.12}
        maxZoom={2}
        panOnScroll
        zoomOnScroll={false}
        fitView
        className="schema-flow"
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          reactFlowRef.current = instance
        }}
      >
        <Background
          color="color-mix(in oklch, var(--muted-foreground) 12%, transparent)"
          gap={GRID_SIZE}
        />
        <Controls />
        <MiniMap />

        <Card className="absolute left-4 top-4 z-20 w-[min(100vw-2rem,22rem)] border-border/60 bg-background/95 shadow-md backdrop-blur-sm">
          <CardHeader className="space-y-1 px-3 py-2 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground">
              Canvas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-3 pb-3 pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <Popover open={jumpOpen} onOpenChange={setJumpOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-1"
                    type="button"
                  >
                    <Search className="h-3.5 w-3.5" />
                    Find table
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[min(calc(100vw-2rem),280px)] p-0 z-[100]"
                  align="start"
                >
                  <Command className="rounded-xl border-0 shadow-none">
                    <CommandInput
                      placeholder="Search tables…"
                      className="text-sm"
                    />
                    <CommandList>
                      <CommandEmpty>No tables found.</CommandEmpty>
                      <CommandGroup heading="Tables">
                        {sortedTables.map((t) => (
                          <CommandItem
                            key={t.id}
                            value={`${t.name} ${t.id}`}
                            onSelect={() => handleJumpToTable(t.id)}
                          >
                            {t.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="h-8 gap-1"
                type="button"
                onClick={() => addCanvas('note')}
              >
                <StickyNote className="h-3.5 w-3.5" />
                Note
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 gap-1"
                type="button"
                onClick={() => addCanvas('image')}
              >
                <ImageIcon className="h-3.5 w-3.5" aria-hidden />
                Image
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 gap-1"
                type="button"
                onClick={() => addCanvas('cron')}
              >
                <AlarmClock className="h-3.5 w-3.5" />
                Cron
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                type="button"
                onClick={autoLayout}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Align
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={clusterMode}
                onValueChange={(v) =>
                  setClusterMode(v as 'heuristic' | 'gemini')
                }
                disabled={clusterGrouped || clusterLayoutBusy}
              >
                <SelectTrigger className="nodrag h-8 w-[8.75rem] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[100]">
                  <SelectItem value="heuristic">Heuristic</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant={clusterGrouped ? 'default' : 'outline'}
                className="h-8 gap-1"
                type="button"
                disabled={clusterLayoutBusy || tables.length === 0}
                onClick={() =>
                  clusterGrouped
                    ? ungroupSmartClusters()
                    : void applySmartCluster()
                }
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                {clusterGrouped ? 'Ungroup' : 'Cluster'}
              </Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-2">
              <Label
                htmlFor="schema-edge-smooth"
                className="text-[11px] font-medium leading-tight text-muted-foreground"
              >
                Smooth FK edges
              </Label>
              <Switch
                id="schema-edge-smooth"
                size="sm"
                checked={relEdgeType === 'smoothstep'}
                onCheckedChange={(c) =>
                  persistRelEdgeType(c ? 'smoothstep' : 'step')
                }
              />
            </div>
          </CardContent>
        </Card>

        {clusterGrouped && clusterLayouts.length > 0 && (
          <Card className="absolute right-4 top-28 z-20 w-[min(100vw-2rem,14rem)] border-border/60 bg-background/95 shadow-md backdrop-blur-sm">
            <CardHeader className="space-y-0 px-3 py-2 pb-2">
              <CardTitle className="text-xs font-semibold text-muted-foreground">
                Clusters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-3 pb-3 pt-0">
              {clusterLayouts.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 text-[11px] leading-tight"
                >
                  <div
                    className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border/50"
                    style={{ backgroundColor: c.colorHex }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {c.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {c.tableIds.length}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {inspectorOpen && selectedRelationship && (
          <Card className="absolute right-4 top-4 z-20 w-60 border-border/60 bg-background/95 text-xs shadow-md backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 px-3 py-2 pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">
                Relationship
              </CardTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag h-7 w-7 shrink-0"
                aria-label="Close"
                onClick={() => setInspectorOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2 px-3 pb-3 pt-0">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Cardinality
                </Label>
                <Select
                  value={selectedRelationship.type}
                  onValueChange={(v) =>
                    updateRelationship(selectedRelationship.id, {
                      type: v as (typeof selectedRelationship)['type'],
                    })
                  }
                >
                  <SelectTrigger className="nodrag h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[100]">
                    <SelectItem value="one-to-many">One to many</SelectItem>
                    <SelectItem value="one-to-one">One to one</SelectItem>
                    <SelectItem value="many-to-many">Many to many</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="nodrag h-8 w-full"
                type="button"
                onClick={() =>
                  updateRelationship(selectedRelationship.id, {
                    sourceTableId: selectedRelationship.targetTableId,
                    sourceColumnId: selectedRelationship.targetColumnId,
                    targetTableId: selectedRelationship.sourceTableId,
                    targetColumnId: selectedRelationship.sourceColumnId,
                  })
                }
              >
                Flip direction
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="nodrag h-8 w-full"
                type="button"
                onClick={() => {
                  deleteRelationship(selectedRelationship.id)
                  setSelectedRelationshipId(null)
                  setInspectorOpen(false)
                }}
              >
                Remove link
              </Button>
            </CardContent>
          </Card>
        )}

        {inspectorOpen && !selectedRelationship && (
          <Card className="absolute right-4 top-4 z-20 w-60 border-border/60 bg-background/95 shadow-md backdrop-blur-sm">
            <CardContent className="px-3 py-3">
              <Alert variant="destructive">
                <AlertTitle className="text-xs">Relationship unavailable</AlertTitle>
                <AlertDescription className="text-[11px]">
                  This link may have been removed. Close and select another edge.
                </AlertDescription>
              </Alert>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                onClick={() => {
                  setInspectorOpen(false)
                  setSelectedRelationshipId(null)
                }}
              >
                Close
              </Button>
            </CardContent>
          </Card>
        )}
      </ReactFlow>
    </div>
  )
}
