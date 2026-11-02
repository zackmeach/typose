/** Native parser maps use one pair per displayed UTF-16 unit, with outward scalar boundaries. */
export function mappedBoundary(encoded: string, offset: number, side: 'start' | 'end'): number | undefined {
  const linear = /^L:(\d+):(\d+):(\d+)$/.exec(encoded)
  if (linear) {
    const [, start, width, units] = linear.map(Number)
    const value = start + width * offset
    if (Number.isSafeInteger(offset) && offset >= 0 && offset <= units && width > 0 && Number.isSafeInteger(value)) return value
    return
  }
  const pairs = encoded.split(',')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > pairs.length || !encoded) return
  const index = side === 'start' ? Math.min(offset, pairs.length - 1) : Math.max(0, offset - 1)
  const pair = /^(\d+):(\d+)$/.exec(pairs[index])
  if (!pair) return
  const start = Number(pair[1]), end = Number(pair[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return
  return side === 'start' ? offset === pairs.length ? end : start : offset === 0 ? start : end
}

function endpoint(root: HTMLElement, node: Node, offset: number, side: 'start' | 'end'): number | undefined {
  if (!root.contains(node)) return
  const element = node instanceof Element ? node : node.parentElement
  let run = element?.closest<HTMLElement>('[data-source-map]')
  if (!run && node instanceof Element) {
    const child = node.childNodes[side === 'start' ? offset : offset - 1]
    const candidate = child instanceof Element ? child : child?.parentElement
    run = candidate?.matches('[data-source-map]') ? candidate as HTMLElement :
      (side === 'start' ? candidate?.querySelector<HTMLElement>('[data-source-map]') : [...candidate?.querySelectorAll<HTMLElement>('[data-source-map]') ?? []].at(-1))
    if (run && root.contains(run)) return mappedBoundary(run.dataset.sourceMap ?? '', side === 'start' ? 0 : run.textContent?.length ?? 0, side)
  }
  if (!run || !root.contains(run)) return
  const prefix = document.createRange()
  prefix.selectNodeContents(run)
  try { prefix.setEnd(node, offset) } catch { return }
  return mappedBoundary(run.dataset.sourceMap ?? '', prefix.toString().length, side)
}

/** Uses parser provenance, never a search/re-encode of the rendered text. Generated UI is refused. */
export function renderedSelection(root: HTMLElement, selection: Selection | null): { start: number; end: number } | undefined {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  const start = endpoint(root, range.startContainer, range.startOffset, 'start')
  const end = endpoint(root, range.endContainer, range.endOffset, 'end')
  if (start === undefined || end === undefined || end <= start) return
  return { start, end }
}
