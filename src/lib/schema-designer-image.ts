/** Resize/compress images before sending to Groq vision (size + latency). */

const MAX_EDGE_PX = 1920
const JPEG_QUALITY_START = 0.82
const MAX_OUTPUT_BYTES = 1_800_000

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read image'))
    }
    img.src = url
  })
}

function scaleDimensions(
  w: number,
  h: number,
  maxEdge: number
): { w: number; h: number } {
  if (w <= maxEdge && h <= maxEdge) return { w, h }
  const ratio = Math.min(maxEdge / w, maxEdge / h)
  return {
    w: Math.max(1, Math.round(w * ratio)),
    h: Math.max(1, Math.round(h * ratio)),
  }
}

async function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
  )
  if (!blob) throw new Error('Image encoding failed')
  return blob
}

export type PreparedSchemaDesignerImage = {
  mime_type: string
  data_base64: string
  data_url: string
}

/**
 * Downscale and JPEG-compress for Groq vision; yields base64 without data: prefix.
 */
export async function prepareSchemaDesignerImageFile(
  file: File
): Promise<PreparedSchemaDesignerImage> {
  const img = await loadImageFromFile(file)
  const { w, h } = scaleDimensions(img.naturalWidth, img.naturalHeight, MAX_EDGE_PX)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not available')
  ctx.drawImage(img, 0, 0, w, h)

  let quality = JPEG_QUALITY_START
  let blob = await canvasToJpegBlob(canvas, quality)
  while (blob.size > MAX_OUTPUT_BYTES && quality > 0.45) {
    quality -= 0.07
    blob = await canvasToJpegBlob(canvas, quality)
  }
  if (blob.size > MAX_OUTPUT_BYTES) {
    const factor = 0.85
    canvas.width = Math.max(1, Math.round(w * factor))
    canvas.height = Math.max(1, Math.round(h * factor))
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    quality = 0.72
    blob = await canvasToJpegBlob(canvas, quality)
  }

  const mime_type = 'image/jpeg'
  const data_url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(new Error('Image encoding failed'))
    r.readAsDataURL(blob)
  })
  const comma = data_url.indexOf(',')
  const data_base64 =
    comma >= 0 ? data_url.slice(comma + 1) : data_url.replace(/^data:[^;]+;base64,/, '')
  return { mime_type, data_base64, data_url }
}

export const SCHEMA_DESIGNER_MAX_IMAGES_PER_SEND = 3

export const SCHEMA_DESIGNER_IMAGE_ONLY_PROMPT =
  'Infer a PostgreSQL-oriented database schema from this image. Output the required JSON code block first, then narrative sections as usual.'
