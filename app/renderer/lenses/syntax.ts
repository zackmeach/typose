import type { HighlighterCore, ThemedToken } from 'shiki/core'

/** All grammars and the regular-expression engine are packaged locally; no WASM eval or network. */
export const OFFLINE_LANGUAGES = new Set(['ts', 'typescript', 'js', 'javascript', 'json', 'jsonc', 'rust', 'python', 'css', 'html', 'bash', 'yaml', 'markdown', 'md'])
let highlighting: Promise<HighlighterCore> | undefined

function highlighter(): Promise<HighlighterCore> {
  return highlighting ??= Promise.all([
    import('shiki/core'), import('shiki/engine/javascript'), import('@shikijs/themes/github-dark'),
    import('@shikijs/langs/typescript'), import('@shikijs/langs/javascript'), import('@shikijs/langs/json'),
    import('@shikijs/langs/rust'), import('@shikijs/langs/python'), import('@shikijs/langs/css'),
    import('@shikijs/langs/html'), import('@shikijs/langs/bash'), import('@shikijs/langs/yaml'),
    import('@shikijs/langs/markdown'), import('@shikijs/langs/jsonc')
  ]).then(([core, engine, theme, ...languages]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(), themes: [theme.default], langs: languages.map(language => language.default)
  }))
}

/** Null keeps readable source for unknown languages or an oversized piece. Caller owns generation and budget. */
export async function tokenizeOffline(source: string, language: string): Promise<ThemedToken[][] | null> {
  if (!OFFLINE_LANGUAGES.has(language) || source.length > 32 << 10) return null
  return (await highlighter()).codeToTokens(source, { lang: language, theme: 'github-dark', tokenizeMaxLineLength: 10000 }).tokens
}
