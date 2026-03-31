'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import { v4 as uuidv4 } from 'uuid'
import ReactFlow, {
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  MiniMap,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { CreateTableModal } from '@/components/schema-designer/CreateTableModal'
import { EditTableModal } from '@/components/schema-designer/EditTableModal'
import { LoadingOverlay } from '@/components/schema-designer/LoadingOverlay'
import { RelationshipEdge } from '@/components/schema-designer/RelationshipEdge'
import { SchemaToolbar } from '@/components/schema-designer/SchemaToolbar'
import { TableNode } from '@/components/schema-designer/TableNode'
import { applySchemaLayout } from '@/lib/schema-designer/reactflowLayout'
import { syncSchemaRelationships } from '@/lib/schema-designer/schemaParser'
import type {
  RelationshipEdgeData,
  SchemaData,
  SchemaRelationship,
  TableSchema,
  TableNodeData,
} from '@/lib/schema-designer/types'

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function stripHandle(handle?: string | null) {
  if (!handle) return null
  return handle.replace(/:(source|target)$/, '')
}

function relationshipHighlights(schema: SchemaData | null, relationshipId: string | null) {
  if (!schema || !relationshipId) return new Map<string, string[]>()
  const relationship = schema.relationships.find((entry) => entry.id === relationshipId)
  if (!relationship) return new Map<string, string[]>()
  return new Map([
    [relationship.sourceTableId, [relationship.sourceColumnId]],
    [relationship.targetTableId, [relationship.targetColumnId]],
  ])
}

function buildNodes({
  schema,
  selectedTableId,
  activeRelationshipId,
  onEdit,
  onSelect,
}: {
  schema: SchemaData | null
  selectedTableId: string | null
  activeRelationshipId: string | null
  onEdit: (table: TableSchema) => void
  onSelect: (tableId: string | null) => void
}): Node<TableNodeData>[] {
  if (!schema) return []
  const highlights = relationshipHighlights(schema, activeRelationshipId)
  return schema.tables.map((table) => ({
    id: table.id,
    type: 'schema-table',
    position: table.position ?? { x: 0, y: 0 },
    data: {
      table,
      highlightedColumnIds: highlights.get(table.id) ?? [],
      isSelected: selectedTableId === table.id,
      onEdit,
      onSelect: (tableId) => onSelect(tableId),
    },
    draggable: true,
  }))
}

function buildEdges({
  schema,
  activeRelationshipId,
}: {
  schema: SchemaData | null
  activeRelationshipId: string | null
}): Edge<RelationshipEdgeData>[] {
  if (!schema) return []
  return schema.relationships.map((relationship) => ({
    id: relationship.id,
    source: relationship.sourceTableId,
    target: relationship.targetTableId,
    sourceHandle: `${relationship.sourceColumnId}:source`,
    targetHandle: `${relationship.targetColumnId}:target`,
    type: 'schema-relationship',
    data: {
      kind: relationship.kind,
      color: relationship.color,
      label: relationship.label,
      isActive: relationship.id === activeRelationshipId,
    },
    animated: relationship.id === activeRelationshipId,
  }))
}

function fitTablePositions(schema: SchemaData, positions: Record<string, { x: number; y: number }>) {
  return {
    ...schema,
    tables: schema.tables.map((table) => ({
      ...table,
      position: positions[table.id] ?? table.position ?? { x: 0, y: 0 },
    })),
  }
}

function createRelationshipFromConnection(connection: Connection, schema: SchemaData): SchemaRelationship | null {
  const sourceColumnId = stripHandle(connection.sourceHandle)
  const targetColumnId = stripHandle(connection.targetHandle)
  if (!connection.source || !connection.target || !sourceColumnId || !targetColumnId) return null

  const sourceTable = schema.tables.find((table) => table.id === connection.source)
  const targetTable = schema.tables.find((table) => table.id === connection.target)
  const sourceColumn = sourceTable?.columns.find((column) => column.id === sourceColumnId)
  const targetColumn = targetTable?.columns.find((column) => column.id === targetColumnId)
  if (!sourceTable || !targetTable || !sourceColumn || !targetColumn) return null

  return {
    id: uuidv4(),
    sourceTableId: sourceTable.id,
    sourceColumnId,
    targetTableId: targetTable.id,
    targetColumnId,
    kind: targetColumn.primaryKey || targetColumn.unique ? '1:N' : '1:N',
    color: sourceTable.color,
    label: `${sourceTable.name}.${sourceColumn.name} -> ${targetTable.name}.${targetColumn.name}`,
  }
}

function schemaWithConnectedReference(schema: SchemaData, relationship: SchemaRelationship): SchemaData {
  const targetTable = schema.tables.find((table) => table.id === relationship.targetTableId)
  const targetColumn = targetTable?.columns.find(
    (column) => column.id === relationship.targetColumnId
  )

  if (!targetTable || !targetColumn) {
    return syncSchemaRelationships(schema)
  }

  return syncSchemaRelationships({
    ...schema,
    tables: schema.tables.map((table) => {
      if (table.id !== relationship.sourceTableId) return table
      return {
        ...table,
        columns: table.columns.map((column) =>
          column.id === relationship.sourceColumnId
            ? {
                ...column,
                references: {
                  table: targetTable.name,
                  column: targetColumn.name,
                  onDelete: column.references?.onDelete ?? 'CASCADE',
                  onUpdate: column.references?.onUpdate ?? 'CASCADE',
                },
              }
            : column
        ),
      }
    }),
  })
}

function InnerSchemaCanvas({
  schema,
  loading,
  layoutDirection,
  selectedTableId,
  selectedRelationshipId,
  hoveredRelationshipId,
  onSchemaChange,
  onLayoutDirectionChange,
  onSelectTable,
  onSelectRelationship,
  onHoverRelationship,
  onAskAiModify,
}: {
  schema: SchemaData | null
  loading?: boolean
  layoutDirection: 'LR' | 'TB'
  selectedTableId: string | null
  selectedRelationshipId: string | null
  hoveredRelationshipId: string | null
  onSchemaChange: (schema: SchemaData) => void
  onLayoutDirectionChange: (direction: 'LR' | 'TB') => void
  onSelectTable: (tableId: string | null) => void
  onSelectRelationship: (relationshipId: string | null) => void
  onHoverRelationship: (relationshipId: string | null) => void
  onAskAiModify?: (prompt: string) => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)
  const [editTable, setEditTable] = useState<TableSchema | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const activeRelationshipId = hoveredRelationshipId ?? selectedRelationshipId

  const nodes = useMemo(
    () =>
      buildNodes({
        schema,
        selectedTableId,
        activeRelationshipId,
        onEdit: setEditTable,
        onSelect: onSelectTable,
      }),
    [schema, selectedTableId, activeRelationshipId, onSelectTable]
  )
  const edges = useMemo(
    () => buildEdges({ schema, activeRelationshipId }),
    [schema, activeRelationshipId]
  )

  const [flowNodes, setNodes, onNodesChange] = useNodesState(nodes)
  const [flowEdges, setEdges, onEdgesChange] = useEdgesState(edges)

  useEffect(() => setNodes(nodes), [nodes, setNodes])
  useEffect(() => setEdges(edges), [edges, setEdges])

  const selectedTable = useMemo(
    () => schema?.tables.find((table) => table.id === selectedTableId) ?? null,
    [schema, selectedTableId]
  )

  const handleAutoLayout = () => {
    if (!schema) return
    const next = applySchemaLayout(schema, layoutDirection)
    onSchemaChange(next)
    requestAnimationFrame(() => {
      reactFlowRef.current?.fitView({ duration: 300, padding: 0.16 })
    })
  }

  const handleExportJson = () => {
    if (!schema) return
    downloadBlob(
      'schema-designer.json',
      new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' })
    )
  }

  const handleExportPng = async () => {
    if (!wrapperRef.current) return
    const canvas = await html2canvas(wrapperRef.current, {
      backgroundColor: '#090909',
      scale: window.devicePixelRatio > 1 ? 2 : 1,
    })
    canvas.toBlob((blob) => {
      if (!blob) return
      downloadBlob('schema-designer.png', blob)
    })
  }

  return (
    <div ref={wrapperRef} className="relative h-full overflow-hidden rounded-[30px] border border-white/8 bg-[#090909] shadow-[0_26px_80px_rgba(0,0,0,0.42)]">
      <ContextMenu>
        <ContextMenuTrigger className="h-full w-full">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={{ 'schema-table': TableNode }}
            edgeTypes={{ 'schema-relationship': RelationshipEdge }}
            onInit={(instance) => {
              reactFlowRef.current = instance
              requestAnimationFrame(() => instance.fitView({ padding: 0.16 }))
            }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => onSelectTable(node.id)}
            onEdgeClick={(_, edge) => onSelectRelationship(edge.id)}
            onEdgeMouseEnter={(_, edge) => onHoverRelationship(edge.id)}
            onEdgeMouseLeave={() => onHoverRelationship(null)}
            onPaneClick={() => {
              onSelectTable(null)
              onSelectRelationship(null)
            }}
            onNodeDragStop={(_, node) => {
              if (!schema) return
              const positions = Object.fromEntries(
                flowNodes.map((entry) => [
                  entry.id,
                  entry.id === node.id ? node.position : entry.position,
                ])
              )
              onSchemaChange(fitTablePositions(schema, positions))
            }}
            onConnect={(connection) => {
              if (!schema) return
              const relationship = createRelationshipFromConnection(connection, schema)
              if (!relationship) return
              onSchemaChange(schemaWithConnectedReference(schema, relationship))
              setEdges((current) => addEdge({
                ...connection,
                id: relationship.id,
                type: 'schema-relationship',
                data: {
                  kind: relationship.kind,
                  color: relationship.color,
                  label: relationship.label,
                },
              }, current))
            }}
            fitView
            minZoom={0.2}
            maxZoom={1.8}
            defaultEdgeOptions={{
              style: { strokeLinecap: 'round' },
            }}
            connectionLineStyle={{ stroke: '#6366f1', strokeWidth: 2 }}
            onlyRenderVisibleElements
            className="!bg-transparent"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgba(255,255,255,0.12)" />
            <Controls className="!border-white/10 !bg-[#111111]/90 !text-zinc-200" />
            <MiniMap
              pannable
              zoomable
              className="!bg-[#111111]/90 !border !border-white/10"
              nodeColor={(node) => (node.data as TableNodeData).table.color}
            />
          </ReactFlow>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setCreateOpen(true)}>Add new table</ContextMenuItem>
          <ContextMenuItem onClick={handleAutoLayout}>Auto layout</ContextMenuItem>
          <ContextMenuItem onClick={() => reactFlowRef.current?.fitView({ padding: 0.16 })}>Fit view</ContextMenuItem>
          <ContextMenuItem onClick={handleExportJson}>Export JSON</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <SchemaToolbar
        layoutDirection={layoutDirection}
        onToggleLayoutDirection={() => {
          const nextDirection = layoutDirection === 'LR' ? 'TB' : 'LR'
          onLayoutDirectionChange(nextDirection)
          if (!schema) return
          onSchemaChange(applySchemaLayout(schema, nextDirection))
        }}
        onFitView={() => reactFlowRef.current?.fitView({ padding: 0.16 })}
        onZoomIn={() => reactFlowRef.current?.zoomIn({ duration: 180 })}
        onZoomOut={() => reactFlowRef.current?.zoomOut({ duration: 180 })}
        onExportJson={handleExportJson}
        onExportPng={() => void handleExportPng()}
      />

      <CreateTableModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(table) => {
          const nextSchema = schema ?? {
            tables: [],
            enums: [],
            relationships: [],
            metadata: {
              databaseType: 'postgresql',
              version: '1.0',
              description: '',
              totalTables: 0,
              totalRelationships: 0,
            },
          }
          onSchemaChange(
            syncSchemaRelationships({
              ...nextSchema,
              tables: [...nextSchema.tables, table],
            })
          )
          toast.success(`Created ${table.name}`)
        }}
      />

      <EditTableModal
        open={Boolean(editTable)}
        onOpenChange={(open) => {
          if (!open) setEditTable(null)
        }}
        table={editTable}
        allTables={schema?.tables ?? []}
        onSave={(updated) => {
          if (!schema) return
          onSchemaChange(
            syncSchemaRelationships({
              ...schema,
              tables: schema.tables.map((table) => (table.id === updated.id ? updated : table)),
            })
          )
          setEditTable(null)
        }}
        onDelete={() => {
          if (!schema || !editTable) return
          onSchemaChange(
            syncSchemaRelationships({
              ...schema,
              tables: schema.tables.filter((table) => table.id !== editTable.id),
            })
          )
          setEditTable(null)
        }}
        onAskAiModify={onAskAiModify}
      />

      {loading ? <LoadingOverlay /> : null}
      {selectedTable ? (
        <div className="absolute left-4 top-4 z-20 rounded-full border border-white/10 bg-[#111111]/85 px-3 py-2 text-xs text-zinc-300 backdrop-blur-xl">
          Selected: <span className="font-medium text-white">{selectedTable.name}</span>
        </div>
      ) : null}
    </div>
  )
}

export function SchemaCanvas(props: Parameters<typeof InnerSchemaCanvas>[0]) {
  return (
    <ReactFlowProvider>
      <InnerSchemaCanvas {...props} />
    </ReactFlowProvider>
  )
}
