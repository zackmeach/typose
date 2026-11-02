import { parseDocument, stringify } from 'yaml'
import { renderMath } from '../math/math'
import { renderDiagram } from '../mermaid/diagram'
import { OFFLINE_LANGUAGES, tokenizeOffline } from './syntax'

const CALLOUTS: Record<string, string> = {
  note: 'blue', info: 'blue', todo: 'blue', tip: 'green', success: 'green', important: 'purple',
  question: 'purple', example: 'purple', warning: 'yellow', caution: 'pink', danger: 'pink', error: 'pink',
  bug: 'pink', failure: 'pink', quote: 'neutral', abstract: 'neutral'
}

async function highlight(code: HTMLElement): Promise<void> {
  const lang = [...code.classList].find(name => name.startsWith('language-'))?.slice(9)
  if (!lang || !OFFLINE_LANGUAGES.has(lang)) return
  const original = code.textContent ?? ''
  if (original.length > 32 << 10) return
  try {
    const tokens = await tokenizeOffline(original, lang)
    if (!tokens) return
    if (!code.isConnected || code.textContent !== original) return
    // Color spans sit INSIDE each native provenance span, so source selections remain mapped.
    let cursor = 0
    const pieces: Array<{ content: string; variants: Record<string, { color?: string }> }> =
      tokens.flatMap((line, index) => [...line, ...(index < tokens.length - 1 ? [{ content: '\n', variants: {} }] : [])])
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    let tokenIndex = 0, tokenOffset = 0
    for (const node of nodes) {
      const fragment = document.createDocumentFragment()
      let offset = 0
      while (offset < node.length && tokenIndex < pieces.length) {
        const token = pieces[tokenIndex]
        const count = Math.min(node.length - offset, token.content.length - tokenOffset)
        if (count === 0) { tokenIndex++; tokenOffset = 0; continue }
        const span = document.createElement('span')
        span.textContent = node.data.slice(offset, offset + count)
        // Both themes' colors ride as custom properties; markdown-extras.css picks the app theme's, so a switch repaints.
        span.className = 'tp-token'
        for (const scheme of ['light', 'dark']) {
          const color = token.variants[scheme]?.color
          if (color && /^#[\da-f]{6,8}$/i.test(color)) span.style.setProperty('--tp-' + scheme, color)
        }
        fragment.append(span)
        offset += count; cursor += count; tokenOffset += count
        if (tokenOffset === token.content.length) { tokenIndex++; tokenOffset = 0 }
      }
      if (offset < node.length) fragment.append(node.data.slice(offset))
      node.replaceWith(fragment)
    }
    if (cursor) code.dataset.highlighted = '1'
  } catch (error) { code.title = error instanceof Error ? error.message : 'Syntax highlighting unavailable' }
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

/** Enhances only native-generated inert markers; raw HTML never supplies these own tags/attributes. */
export function markdownExtras(root: HTMLElement, current: () => boolean, reserve: (bytes: number) => Promise<boolean> = async () => true): Promise<void> {
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-frontmatter="1"]')) frontmatter(pre)
  for (const quote of root.querySelectorAll<HTMLElement>('blockquote')) {
    const first = quote.querySelector('p')
    const marker = /^\[!([A-Za-z]+)\][+-]?(?:[ \t]+([^\n]*))?/.exec(first?.textContent ?? '')
    const kind = quote.dataset.callout ?? marker?.[1].toLowerCase()
    if (!kind || !CALLOUTS[kind]) continue
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
      if (!current() || source.length > 8192 || !await reserve((1 << 20) + source.length * 512)) { math.title = 'Math source kept · rendering budget exceeded'; return }
      await renderMath(math, source, math.dataset.display === '1')
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
    } else pending.push(async () => {
      if (!current() || !await reserve((1 << 20) + (code.textContent?.length ?? 0) * 64)) return
      await highlight(code)
    })
  }
  return Promise.all([0, 1].map(async () => { while (current() && pending.length) await pending.shift()!() })).then(() => {})
}
