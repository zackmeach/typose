import { describe, expect, it, vi } from 'vitest'
import { copySourceSpan, SOURCE_COPY_CHUNK } from './source-copy'

describe('copySourceSpan', () => {
  it('streams a bounded source span without splitting decoded UTF-8', async () => {
    const prefix = new TextEncoder().encode('a'.repeat(SOURCE_COPY_CHUNK - 1))
    const suffix = new TextEncoder().encode('é\n')
    const source = new Uint8Array(prefix.length + suffix.length)
    source.set(prefix); source.set(suffix, prefix.length)
    const writes: string[] = []
    const read = vi.fn(async (start: number, count: number) => source.slice(start, start + count))
    const ok = await copySourceSpan({
      valid: () => true,
      reserve: async () => true,
      read,
      verify: async () => true,
      confirm: async () => true,
      write: async text => { writes.push(text); return true },
      cancelWrite: () => {}
    }, 0, source.length, 'utf-8', new AbortController().signal)
    expect(ok).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    expect(writes).toEqual(['a'.repeat(SOURCE_COPY_CHUNK - 1) + 'é\n'])
  })

  it('preserves a leading BOM as part of the source bytes', async () => {
    const source = new TextEncoder().encode('\uFEFFvalue')
    let copied = ''
    const ok = await copySourceSpan({
      valid: () => true,
      reserve: async () => true,
      read: async (start, count) => source.slice(start, start + count),
      verify: async () => true,
      confirm: async () => true,
      write: async text => { copied = text; return true },
      cancelWrite: () => {}
    }, 0, source.length, 'utf-8', new AbortController().signal)
    expect(ok).toBe(true)
    expect(copied).toBe('\uFEFFvalue')
  })

  it('does not write when a large-copy confirmation is declined', async () => {
    const size = 11 << 20
    const read = vi.fn(async (_start: number, count: number) => new Uint8Array(count).fill(97))
    const write = vi.fn(async () => true)
    const confirm = vi.fn(async () => false)
    const ok = await copySourceSpan({
      valid: () => true,
      reserve: async () => true,
      read,
      verify: async () => true,
      confirm,
      write,
      cancelWrite: () => {}
    }, 0, size, 'utf-8', new AbortController().signal)
    expect(ok).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  }, 30000)

  it('does not commit a prepared copy after its final source verification fails', async () => {
    const size = 11 << 20
    const write = vi.fn(async () => true)
    const verify = vi.fn(async () => false)
    const ok = await copySourceSpan({
      valid: () => true,
      reserve: async () => true,
      read: async (_start, count) => new Uint8Array(count).fill(97),
      verify,
      confirm: async () => true,
      write,
      cancelWrite: () => {}
    }, 0, size, 'utf-8', new AbortController().signal)
    expect(ok).toBe(false)
    expect(verify).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  }, 30000)
})
