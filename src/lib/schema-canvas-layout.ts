/** Shared layout metrics for schema designer canvas nodes and auto-layout height estimates. */

export const GRID_SIZE = 20
export const COLUMN_GAP = 420
export const ROW_GAP = 60

/** Nominal canvas card width — use when placing new tables so they do not overlap. */
export const ERD_TABLE_CARD_WIDTH = 300
/** Horizontal gap between auto-placed table nodes (px). */
export const ERD_NEW_TABLE_GAP = 48

/** Table name row (px). */
export const TABLE_TITLE_BAR_HEIGHT = 36
/** Separator between title and body (px). */
export const TABLE_HEADER_SEPARATOR_HEIGHT = 1
/**
 * "Field / Type" label row — keeps columns visually aligned like a classic ERD.
 * (px, includes vertical padding.)
 */
export const TABLE_COLUMN_LABEL_ROW_HEIGHT = 24

/**
 * Y-offset from node top to the **top** of the first data row (React Flow handle math).
 */
export const HEADER_HEIGHT =
  TABLE_TITLE_BAR_HEIGHT +
  TABLE_HEADER_SEPARATOR_HEIGHT +
  TABLE_COLUMN_LABEL_ROW_HEIGHT

/** One data row height — keep in sync with table-node row min-height. */
export const ROW_HEIGHT = 30

export const INDEX_BLOCK_HEIGHT = 68

/** Extra vertical padding inside table card (body + borders). */
export const TABLE_CARD_BODY_PADDING_Y = 16

export function createSchemaColumnId(): string {
  return `col-${Date.now()}`
}

/** Estimated total card height for layout — matches FlowCanvas / auto-layout heuristics. */
export function estimateErdaTableHeight(
  columnCount: number,
  indexCount: number
): number {
  return (
    HEADER_HEIGHT +
    columnCount * ROW_HEIGHT +
    (indexCount > 0 ? INDEX_BLOCK_HEIGHT : 0) +
    TABLE_CARD_BODY_PADDING_Y
  )
}

/** Snap X so new tables align to the canvas grid. */
export function snapCanvasX(x: number): number {
  return Math.round(x / GRID_SIZE) * GRID_SIZE
}

/** Default top-left for a newly added table (index = existing table count). */
export function defaultTablePosition(tableIndex: number): { x: number; y: number } {
  const baseX = GRID_SIZE * 6
  const baseY = GRID_SIZE * 6
  const step = ERD_TABLE_CARD_WIDTH + ERD_NEW_TABLE_GAP
  return {
    x: snapCanvasX(baseX + tableIndex * step),
    y: baseY,
  }
}
