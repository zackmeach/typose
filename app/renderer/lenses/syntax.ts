import { workerJobs } from '../worker-jobs'

/** What sanitize.rs's `language-*` class allowlist lets through; syntax.worker.ts bundles exactly these grammars. */
export const OFFLINE_LANGUAGES = new Set(['ts', 'typescript', 'js', 'javascript', 'json', 'rust', 'python', 'css', 'html', 'bash', 'yaml'])
/** A larger block stays plain and pays nothing. */
export const HIGHLIGHT_MAX_CHARS = 32 << 10
/**
 * Colored spans per block; the rest of the block stays plain text. With Windows accessibility on, the browser process
 * serializes every new node: 4,000 spans a block held an eval round-trip to 0.9–1.3 s, 2,000 to 0.22–0.36 s.
 */
export const HIGHLIGHT_MAX_SPANS = 2000
/** A block still tokenizing after this is a runaway: the worker is terminated, and the block stays plain. */
const HIGHLIGHT_TIMEOUT_MS = 1500

/** A run of a block's text and its github-light and github-dark colors; empty colors leave it plain. */
export type Piece = [text: string, light: string, dark: string]

const tokenizeJob = workerJobs<{ source: string; language: string; maxSpans: number }, { pieces: Piece[] } | { error: string }>(
  () => new Worker(new URL('./syntax.worker.ts', import.meta.url), { type: 'module' }), HIGHLIGHT_TIMEOUT_MS)

/** Null keeps readable source for unknown languages or an oversized piece. Caller owns generation and budget. */
export async function tokenizeOffline(source: string, language: string): Promise<Piece[] | null> {
  if (!OFFLINE_LANGUAGES.has(language) || source.length > HIGHLIGHT_MAX_CHARS) return null
  const reply = await tokenizeJob({ source, language, maxSpans: HIGHLIGHT_MAX_SPANS })
  if ('error' in reply) throw new Error(reply.error)
  return reply.pieces
}
