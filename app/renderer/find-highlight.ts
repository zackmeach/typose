/** A single CSS highlight contains at most one range per active card, never all hits. */
const ranges = new Map<object, { current?: Range; visible: readonly Range[] }>()
export function highlightFind(owner: object, range?: Range, visible: readonly Range[] = []): void {
  if (range || visible.length) ranges.set(owner, { current: range, visible: visible.slice(0, 128) })
  else ranges.delete(owner)
  const highlights = globalThis.CSS?.highlights
  if (!highlights) return
  if (!ranges.size) { highlights.delete('typose-find'); highlights.delete('typose-find-current') }
  else {
    highlights.set('typose-find', new Highlight(...[...ranges.values()].flatMap(entry => entry.visible)))
    highlights.set('typose-find-current', new Highlight(...[...ranges.values()].flatMap(entry => entry.current ? [entry.current] : [])))
  }
}
