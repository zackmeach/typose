// Shiki off the main thread: tokenizing a dense or pathological block can't stall the reader, and the caller's watchdog
// terminates a runaway. Grammars, themes and the regular-expression engine are bundled; no WASM eval or network.
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import dark from '@shikijs/themes/github-dark'
import light from '@shikijs/themes/github-light'
import bash from '@shikijs/langs/bash'
import css from '@shikijs/langs/css'
import html from '@shikijs/langs/html'
import javascript from '@shikijs/langs/javascript'
import json from '@shikijs/langs/json'
import python from '@shikijs/langs/python'
import rust from '@shikijs/langs/rust'
import typescript from '@shikijs/langs/typescript'
import yaml from '@shikijs/langs/yaml'
import { WORKER_READY } from '../worker-jobs'
import type { Piece } from './syntax'

const highlighter = createHighlighterCore({
  engine: createJavaScriptRegexEngine(), themes: [dark, light], langs: [bash, css, html, javascript, json, python, rust, typescript, yaml]
})
// Building the grammars is cold start, not a job: the caller's watchdog waits for this.
void highlighter.then(() => self.postMessage(WORKER_READY))

self.onmessage = async (e: MessageEvent<{ source: string; language: string; maxSpans: number }>) => {
  const { source, language, maxSpans } = e.data
  try {
    // A line over 1,000 characters stays one plain token: shiki's time on a long line grows faster than its length.
    const lines = (await highlighter).codeToTokensWithThemes(source, { lang: language, themes: { light: 'github-light', dark: 'github-dark' }, tokenizeMaxLineLength: 1000 })
    const pieces: Piece[] = []
    let spans = 0
    const push = (text: string, lightColor = '', darkColor = '') => {
      // Whitespace, and everything past the span cap, stays plain; adjacent plain pieces merge.
      if (spans >= maxSpans || !text.trim()) lightColor = darkColor = ''
      const last = pieces.at(-1)
      if (!lightColor && !darkColor && last && !last[1] && !last[2]) { last[0] += text; return }
      if (lightColor || darkColor) spans++
      pieces.push([text, lightColor, darkColor])
    }
    lines.forEach((line, index) => {
      if (index) push('\n')
      for (const token of line) push(token.content, token.variants.light?.color, token.variants.dark?.color)
    })
    self.postMessage({ pieces })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
