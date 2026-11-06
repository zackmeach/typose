// Z43 PR 2: an embedded image in a document that isn't Markdown (a Transcript's JSONL), through the real dispatcher
// and the test-hooks addon. The embedded path reads only the document's own bytes, so it needs no Markdown source;
// a local image still does, and a chunk is served only for an id a successful prepare registered.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type * as Core from 'typose-node'
import type { ImageRef, Opened, PreparedImage, SurfaceRef } from '../shared/protocol'
import { makeDispatcher } from './dispatch'

const core = createRequire(import.meta.url)('typose-node/hooks') as typeof Core
core.setBudget(totalmem())
const dir = mkdtempSync(join(tmpdir(), 'typose-embedded-hooks-'))
const dispatcher = makeDispatcher({ coreVersion: core.coreVersion, limits: core.limits, reserveCache: core.reserveCache, cancelFlag: () => new core.Cancel(), openDoc: (path) => core.Doc.open(path) }, 643, () => {})
let next = 1
const call = (method: string, params: Record<string, unknown>) => dispatcher({ id: next++, method, params })
const value = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
  const response = await call(method, params)
  if ('error' in response) throw Object.assign(new Error(response.error.message), response.error)
  return response.result as T
}
// A 1×1 PNG, as an OpenAI chat line's data: URL.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const LINE = JSON.stringify({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }) + '\n'
let surface: SurfaceRef, opened: Opened

beforeAll(async () => {
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, LINE)
  surface = await value<SurfaceRef>('createSurface', {})
  opened = await value<Opened>('open', { surface, path, count: 1, bytes: 0 })
})
afterAll(async () => {
  await call('close', { surface, doc: opened.doc })
  rmSync(dir, { recursive: true, force: true })
})

it('a .jsonl document prepares a data: URL from its JSON string span, and serves its chunk', async () => {
  // The JSON string token, quotes included, as a Transcript node's span is.
  const start = LINE.indexOf('"data:'), end = LINE.indexOf('"', start + 1) + 1
  const image = await value<PreparedImage>('prepareImage', { doc: opened.doc, gen: opened.gen, span: { start, end } })
  expect(image).toMatchObject({ width: 1, height: 1, pixelBytes: 4 })
  const bytes = await value<Uint8Array>('imageChunk', { doc: opened.doc, gen: opened.gen, ref: image.ref, offset: 0 })
  expect(bytes.length).toBe(image.encodedBytes)
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(await value('releaseImage', { doc: opened.doc, gen: opened.gen, ref: image.ref })).toBe(true)
})

it('a local image is still refused on a .jsonl document: its guard is the Markdown source', async () => {
  expect(await call('prepareImage', { doc: opened.doc, gen: opened.gen, src: 'x.png' }))
    .toMatchObject({ error: { code: 'Refused', message: 'local links require a Markdown source' } })
})

it('a chunk of an id no prepare registered is still refused', async () => {
  const ref: ImageRef = { session: 643, doc: opened.doc, gen: opened.gen, id: 99 }
  expect(await call('imageChunk', { doc: opened.doc, gen: opened.gen, ref, offset: 0 }))
    .toMatchObject({ error: { code: 'Refused', message: 'the image resource was released' } })
})
