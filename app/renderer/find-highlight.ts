/** A single CSS highlight contains at most one range per active card, never all hits. */
const ranges = new Map<object, { current?: Range; visible: readonly Range[] }>()
type HighlightWindow = typeof globalThis & {
  Highlight?: new (...ranges: Range[]) => unknown
  CSS: typeof CSS & { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }
}
export function highlightFind(owner: object, range?: Range, visible: readonly Range[] = []): void {
  if (range || visible.length) ranges.set(owner, { current: range, visible: visible.slice(0, 128) })
  else ranges.delete(owner)
  const api = globalThis as HighlightWindow
  if (!api.CSS?.highlights || !api.Highlight) return
  if (!ranges.size) { api.CSS.highlights.delete('typose-find'); api.CSS.highlights.delete('typose-find-current') }
  else {
    api.CSS.highlights.set('typose-find', new api.Highlight(...[...ranges.values()].flatMap(entry => entry.visible)))
    api.CSS.highlights.set('typose-find-current', new api.Highlight(...[...ranges.values()].flatMap(entry => entry.current ? [entry.current] : [])))
  }
}
