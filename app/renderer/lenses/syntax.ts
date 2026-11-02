import type { HighlighterCore, ThemedTokenWithVariants } from 'shiki/core'

/** What sanitize.rs's `language-*` class allowlist lets through. Grammars and the regular-expression engine are packaged
 *  locally; no WASM eval or network. */
export const OFFLINE_LANGUAGES = new Set(['ts', 'typescript', 'js', 'javascript', 'json', 'rust', 'python', 'css', 'html', 'bash', 'yaml'])
let highlighting: Promise<HighlighterCore> | undefined

function highlighter(): Promise<HighlighterCore> {
  return highlighting ??= Promise.all([
    import('shiki/core'), import('shiki/engine/javascript'), import('@shikijs/themes/github-dark'), import('@shikijs/themes/github-light'),
    import('@shikijs/langs/typescript'), import('@shikijs/langs/javascript'), import('@shikijs/langs/json'),
    import('@shikijs/langs/rust'), import('@shikijs/langs/python'), import('@shikijs/langs/css'),
    import('@shikijs/langs/html'), import('@shikijs/langs/bash'), import('@shikijs/langs/yaml')
  ]).then(([core, engine, dark, light, ...languages]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(), themes: [dark.default, light.default], langs: languages.map(language => language.default)
  }))
}

/** Null keeps readable source for unknown languages or an oversized piece. Caller owns generation and budget.
 *  Each token carries both themes' colors (`variants.light`, `variants.dark`), so a theme change needs no re-tokenize. */
export async function tokenizeOffline(source: string, language: string): Promise<ThemedTokenWithVariants[][] | null> {
  if (!OFFLINE_LANGUAGES.has(language) || source.length > 32 << 10) return null
  return (await highlighter()).codeToTokensWithThemes(source, { lang: language, themes: { light: 'github-light', dark: 'github-dark' }, tokenizeMaxLineLength: 10000 })
}
