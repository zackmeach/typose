import { parseDocument, stringify } from 'yaml'
import { renderMath } from '../math/math'
import { renderDiagram } from '../mermaid/diagram'
import { HIGHLIGHT_MAX_CHARS, OFFLINE_LANGUAGES, tokenizeOffline } from './syntax'

const CALLOUTS: Record<string, string> = {
  note: 'blue', info: 'blue', todo: 'blue', tip: 'green', success: 'green', important: 'purple',
  question: 'purple', example: 'purple', warning: 'yellow', caution: 'pink', danger: 'pink', error: 'pink',
  bug: 'pink', failure: 'pink', quote: 'neutral', abstract: 'neutral'
}

/**
 * A highlighted block keeps renderer bytes per source character (the worker's tokenizing heap) and per span, each
 * charged before the work it pays for. Eight dense 32 KB JSON blocks plus a 30 KB TS block raised the renderer's private
 * bytes by 82 MiB at a 1,000-span cap, 91–115 MiB over ten runs at 2,000 and 114–135 MiB at 4,000; 2,000 one-line TS
 * blocks (8 spans each) by 10–38 KiB a block after a forced GC. GC noise defeats a linear fit, so the pair covers the
 * worst dense run by a quarter (145.5 MiB at 2,000) and the one-line blocks with room to spare (44.7 KiB a block).
 */
export const HIGHLIGHT_CHAR_BYTES = 320
export const HIGHLIGHT_SPAN_BYTES = 3968
/** A worker job's transit (the source copy, the reply), returned when the job settles. Never kept. */
const JOB_TRANSIT_BYTES = 1 << 20

/** True when spans went in, and their charge stays; otherwise the charge it took is returned. */
async function highlight(code: HTMLElement, lang: string, reserve: (bytes: number) => Promise<boolean>): Promise<boolean> {
  const original = code.textContent ?? ''
  try {
    const pieces = await tokenizeOffline(original, lang)
    if (!pieces || !code.isConnected || code.textContent !== original) return false
    const charge = pieces.filter(([, light, dark]) => light || dark).length * HIGHLIGHT_SPAN_BYTES
    if (!await reserve(charge)) { code.title = 'Highlighting skipped · rendering budget exceeded'; return false }
    if (!code.isConnected || code.textContent !== original) { await reserve(-charge); return false }
    // Color spans sit INSIDE each native provenance span, so source selections remain mapped.
    let spans = 0
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    let tokenIndex = 0, tokenOffset = 0
    for (const node of nodes) {
      const fragment = document.createDocumentFragment()
      let offset = 0
      while (offset < node.length && tokenIndex < pieces.length) {
        const [content, light, dark] = pieces[tokenIndex]
        const count = Math.min(node.length - offset, content.length - tokenOffset)
        if (count === 0) { tokenIndex++; tokenOffset = 0; continue }
        const text = node.data.slice(offset, offset + count)
        if (light || dark) {
          const span = document.createElement('span')
          span.textContent = text
          // Both themes' colors ride as custom properties; markdown-extras.css picks the app theme's, so a switch repaints.
          span.className = 'tp-token'
          if (/^#[\da-f]{6,8}$/i.test(light)) span.style.setProperty('--tp-light', light)
          if (/^#[\da-f]{6,8}$/i.test(dark)) span.style.setProperty('--tp-dark', dark)
          fragment.append(span)
          spans++
        } else fragment.append(text)
        offset += count; tokenOffset += count
        if (tokenOffset === content.length) { tokenIndex++; tokenOffset = 0 }
      }
      if (offset < node.length) fragment.append(node.data.slice(offset))
      node.replaceWith(fragment)
    }
    if (spans) code.dataset.highlighted = '1'
    return true
  } catch (error) {
    code.title = error instanceof Error ? error.message : 'Syntax highlighting unavailable'
    return false
  }
}

function frontmatter(pre: HTMLElement): void {
  const source = pre.textContent ?? ''
  const body = source.replace(/^---[^\n]*\n/, '').replace(/(?:---|\.\.\.)[^\n]*(?:\n)?$/, '')
  try {
    const parsed = parseDocument(body, { uniqueKeys: true, schema: 'failsafe' })
    if (parsed.errors.length) return
    const value: unknown = parsed.toJS({ maxAliasCount: 0 })
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const entries = Object.entries(value)
    if (entries.length > 256) return
    const grid = document.createElement('dl')
    grid.className = 'md-properties'
    grid.setAttribute('aria-label', 'Frontmatter properties')
    for (const [key, value] of entries) {
      const term = document.createElement('dt'), description = document.createElement('dd')
      term.textContent = key
      // Nested values print as YAML flow style (`[a, b]`), as a Markdown author wrote them, not JSON.
      description.textContent = typeof value === 'string' ? value : stringify(value, { schema: 'failsafe', collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0 }).trimEnd()
      grid.append(term, description)
    }
    pre.replaceWith(grid)
  } catch { /* Invalid or aliased YAML keeps the literal bounded source. */ }
}

function removeCalloutMarker(paragraph: HTMLElement, units: number): void {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) {
    if (units <= 0) break
    const removed = Math.min(units, text.length)
    const run = text.parentElement?.closest<HTMLElement>('[data-source-map]')
    if (run && removed < text.length) {
      const map = run.dataset.sourceMap ?? ''
      const linear = /^L:(\d+):(\d+):(\d+)$/.exec(map)
      run.dataset.sourceMap = linear
        ? `L:${Number(linear[1]) + removed * Number(linear[2])}:${linear[2]}:${Number(linear[3]) - removed}`
        : map.split(',').slice(removed).join(',')
    }
    text.deleteData(0, removed)
    units -= removed
    if (run && !run.textContent) run.remove()
  }
}

/**
 * Enhances only native-generated inert markers; raw HTML never supplies these own tags/attributes. `reserve` grows the
 * lens's extras share; a negative amount returns what a settled job no longer holds.
 */
export function markdownExtras(root: HTMLElement, current: () => boolean, reserve: (bytes: number) => Promise<boolean> = async () => true): Promise<void> {
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-frontmatter="1"]')) frontmatter(pre)
  for (const quote of root.querySelectorAll<HTMLElement>('blockquote')) {
    const first = quote.querySelector('p')
    const marker = /^\[!([A-Za-z]+)\][+-]?(?:[ \t]+([^\n]*))?/.exec(first?.textContent ?? '')
    const kind = quote.dataset.callout ?? marker?.[1].toLowerCase()
    if (!kind || !Object.hasOwn(CALLOUTS, kind)) continue
    quote.classList.add('md-callout')
    quote.dataset.tint = CALLOUTS[kind]
    const title = document.createElement('div')
    title.className = 'md-callout-title'
    title.textContent = marker?.[2]?.trim() || kind[0].toUpperCase() + kind.slice(1)
    quote.prepend(title)
    if (marker && first) {
      removeCalloutMarker(first, marker[0].length)
    }
  }
  const pending: Array<() => Promise<void>> = []
  for (const math of root.querySelectorAll<HTMLElement>('.tp-math')) {
    if (!current()) break
    const source = math.textContent ?? ''
    pending.push(async () => {
      // Transit only: renderMath reserves what the rendered formula keeps.
      const transit = JOB_TRANSIT_BYTES + source.length * 512
      if (!current() || source.length > 8192 || !await reserve(transit)) { math.title = 'Math source kept · rendering budget exceeded'; return }
      try { await renderMath(math, source, math.dataset.display === '1', bytes => current() ? reserve(bytes) : Promise.resolve(false)) }
      finally { await reserve(-transit) }
    })
  }
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if (code.classList.contains('language-mermaid')) {
      const host = code.parentElement!
      host.classList.add('md-diagram')
      const source = code.textContent ?? ''
      pending.push(async () => {
        if (!current() || source.length > 32768 || !await reserve((16 << 20) + source.length * 512)) { host.title = 'Diagram source kept · rendering budget exceeded'; return }
        await renderDiagram(host, source)
      })
    } else {
      // Only a block that can highlight pays: unlabeled, unsupported and oversized blocks stay plain for nothing.
      const lang = [...code.classList].find(name => name.startsWith('language-'))?.slice(9)
      const length = code.textContent?.length ?? 0
      if (lang && OFFLINE_LANGUAGES.has(lang) && length <= HIGHLIGHT_MAX_CHARS) pending.push(async () => {
        const kept = length * HIGHLIGHT_CHAR_BYTES
        if (!current() || !await reserve(JOB_TRANSIT_BYTES + kept)) { code.title = 'Highlighting skipped · rendering budget exceeded'; return }
        const lit = await highlight(code, lang, bytes => current() ? reserve(bytes) : Promise.resolve(false))
        await reserve(-(JOB_TRANSIT_BYTES + (lit ? 0 : kept)))
      })
    }
  }
  return Promise.all([0, 1].map(async () => { while (current() && pending.length) await pending.shift()!() })).then(() => {})
}
