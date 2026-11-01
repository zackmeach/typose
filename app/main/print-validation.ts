import { MAX_PRINT_BYTES, MAX_PRINT_NODES, MAX_PRINT_PAGES, type PrintNode, type PrintTag } from '../shared/protocol'

const tags = new Set<PrintTag>(['p','h1','h2','h3','h4','h5','h6','strong','em','del','code','pre','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','a','br','hr','span','img'])

export function validatePrintDocument(title: unknown, blocks: unknown, pages: unknown): { ok: true; title: string; blocks: PrintNode[]; pages: number; json: string } | { ok: false; reason: string } {
  if (typeof title !== 'string' || title.length > 512 || !Array.isArray(blocks)) return { ok: false, reason: 'Invalid print document' }
  if (!Number.isSafeInteger(pages) || (pages as number) < 1 || (pages as number) > MAX_PRINT_PAGES)
    return { ok: false, reason: `Print job exceeds the ${MAX_PRINT_PAGES}-page limit` }
  let nodes = 0, bytes = 0
  const validNodes = (list: unknown, depth: number): list is PrintNode[] => {
    if (!Array.isArray(list) || depth > 32) return false
    for (const node of list) {
      if (++nodes > MAX_PRINT_NODES || !node || typeof node !== 'object') return false
      const item = node as Record<string, unknown>
      if (typeof item.text === 'string' && Object.keys(item).length === 1) {
        bytes += Buffer.byteLength(item.text, 'utf8')
        if (bytes > MAX_PRINT_BYTES) return false
        continue
      }
      if (typeof item.tag !== 'string' || !tags.has(item.tag as PrintTag)) return false
      if (item.tag === 'img') {
        if (Object.keys(item).some(key => !['tag','src','alt'].includes(key)) || typeof item.src !== 'string' || item.src.length > 2 << 20 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(item.src)) return false
        if (item.alt !== undefined && typeof item.alt !== 'string') return false
        bytes += Buffer.byteLength(item.src, 'utf8') + Buffer.byteLength(String(item.alt ?? ''), 'utf8')
        if (bytes > MAX_PRINT_BYTES) return false
        continue
      }
      if (item.tag === 'br' || item.tag === 'hr') {
        if (Object.keys(item).some(key => key !== 'tag')) return false
        continue
      }
      if (Object.keys(item).some(key => !['tag','children'].includes(key)) || !validNodes(item.children ?? [], depth + 1)) return false
    }
    return true
  }
  if (!validNodes(blocks, 0) || bytes > MAX_PRINT_BYTES) return { ok: false, reason: 'Print content is invalid or exceeds the 32 MiB content limit' }
  let json: string
  try { json = JSON.stringify(blocks) } catch { return { ok: false, reason: 'Print content is not serializable' } }
  if (Buffer.byteLength(json, 'utf8') > MAX_PRINT_BYTES) return { ok: false, reason: 'Print content exceeds the 32 MiB serialized limit' }
  return { ok: true, title, blocks, pages: pages as number, json }
}

/** Chromium emits Page objects in the PDF body; a Pages tree count is a fallback for object-stream variants. */
export function physicalPageCount(pdf: Uint8Array): number | null {
  const source = Buffer.from(pdf).toString('latin1')
  const pages = source.match(/\/Type\s*\/Page\b/g)?.length ?? 0
  if (pages) return pages
  const counts = [...source.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map(match => Number(match[1]))
  const count = Math.max(0, ...counts)
  return Number.isSafeInteger(count) && count > 0 ? count : null
}

export const MAX_PRINT_PDF_BYTES = 128 << 20
