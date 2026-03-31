'use client'

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from 'reactflow'
import type { RelationshipEdgeData } from '@/lib/schema-designer/types'

function linePoint(x: number, y: number, angle: number, distance: number) {
  return {
    x: x - Math.cos(angle) * distance,
    y: y - Math.sin(angle) * distance,
  }
}

function markerSegments(kind: 'one' | 'many', x: number, y: number, angle: number) {
  const anchor = linePoint(x, y, angle, 12)
  const normal = angle + Math.PI / 2
  if (kind === 'one') {
    const left = linePoint(anchor.x, anchor.y, normal, 7)
    const right = linePoint(anchor.x, anchor.y, normal + Math.PI, 7)
    return [`M ${left.x} ${left.y} L ${right.x} ${right.y}`]
  }
  const outerLeft = linePoint(anchor.x, anchor.y, normal, 10)
  const outerRight = linePoint(anchor.x, anchor.y, normal + Math.PI, 10)
  const inner = linePoint(x, y, angle, 18)
  return [
    `M ${inner.x} ${inner.y} L ${outerLeft.x} ${outerLeft.y}`,
    `M ${inner.x} ${inner.y} L ${x} ${y}`,
    `M ${inner.x} ${inner.y} L ${outerRight.x} ${outerRight.y}`,
  ]
}

function cardinalityFor(data?: RelationshipEdgeData) {
  switch (data?.kind) {
    case '1:1':
      return { source: 'one' as const, target: 'one' as const }
    case 'N:M':
      return { source: 'many' as const, target: 'many' as const }
    default:
      return { source: 'many' as const, target: 'one' as const }
  }
}

export function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<RelationshipEdgeData>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const color = data?.color ?? '#6366f1'
  const strokeWidth = selected || data?.isActive ? 3 : 2.2
  const angle = Math.atan2(targetY - sourceY, targetX - sourceX)
  const markers = cardinalityFor(data)

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth,
          strokeDasharray: selected || data?.isActive ? '0' : '7 5',
          filter: selected || data?.isActive ? `drop-shadow(0 0 10px ${color})` : undefined,
        }}
      />
      {markerSegments(markers.source, sourceX, sourceY, angle + Math.PI).map((segment, index) => (
        <path key={`${id}-s-${index}`} d={segment} stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" />
      ))}
      {markerSegments(markers.target, targetX, targetY, angle).map((segment, index) => (
        <path key={`${id}-t-${index}`} d={segment} stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" />
      ))}
      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          className="pointer-events-none absolute rounded-full border border-white/10 bg-[#111111]/90 px-2.5 py-1 text-[10px] font-semibold tracking-[0.2em] text-zinc-200 uppercase shadow-lg"
        >
          {data?.kind ?? '1:N'}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
