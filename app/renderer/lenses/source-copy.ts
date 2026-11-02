import { LARGE_COPY_CONFIRM_BYTES, MAX_CLIPBOARD_BYTES } from '../../shared/protocol'
import { utf8ByteLength } from './grid-interactions'

export const SOURCE_COPY_CHUNK = 64 << 10

export interface SourceCopyPort {
  valid(): boolean
  reserve(bytes: number, signal: AbortSignal): Promise<boolean>
  read(start: number, count: number, signal: AbortSignal): Promise<Uint8Array>
  verify?(signal: AbortSignal): Promise<boolean>
  confirm(bytes: number, signal: AbortSignal): Promise<boolean>
  write(text: string): Promise<boolean>
  cancelWrite(): void
  status?(message: string): void
}

/** Copies a verified source byte range as plain text, without re-encoding it to reconstruct byte offsets. */
export async function copySourceSpan(port: SourceCopyPort, start: number, end: number, encoding: string, signal: AbortSignal): Promise<boolean> {
  const current = () => !signal.aborted && port.valid()
  const refuse = (message: string) => { port.status?.(message); return false }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return refuse('Copy refused · invalid source range')
  if (!current()) return refuse('Copy cancelled · the source is no longer active')
  const decoder = new TextDecoder(encoding, { ignoreBOM: true })
  const parts: string[] = []
  let offset = start, inputBytes = 0, outputBytes = 0, charged = 0
  const reserve = async (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !current()) return false
    const wanted = Math.ceil(bytes / (256 << 10)) * (256 << 10)
    if (wanted <= charged) return true
    const granted = await port.reserve(wanted, signal).catch(() => false)
    if (!granted || !current()) return false
    charged = wanted
    return true
  }
  try {
    while (offset < end) {
      const count = Math.min(SOURCE_COPY_CHUNK, end - offset)
      // The source chunk, decoder output, retained string parts and final join can overlap briefly.
      const estimated = (512 << 10) + (inputBytes + count) * 2 + outputBytes * 4
      if (!await reserve(estimated)) return current() ? refuse('Copy unavailable · the memory budget is full') : refuse('Copy cancelled')
      const bytes = await port.read(offset, count, signal)
      if (!current() || bytes.length !== count) return refuse('Copy cancelled · the source changed while reading')
      const text = decoder.decode(bytes, { stream: true })
      inputBytes += bytes.length
      outputBytes += utf8ByteLength(text)
      if (outputBytes > MAX_CLIPBOARD_BYTES) return refuse('Copy refused · selection exceeds the 16 MiB clipboard limit')
      parts.push(text)
      offset += count
    }
    const tail = decoder.decode()
    outputBytes += utf8ByteLength(tail)
    if (outputBytes > MAX_CLIPBOARD_BYTES) return refuse('Copy refused · selection exceeds the 16 MiB clipboard limit')
    if (!current()) return refuse('Copy cancelled')
    parts.push(tail)
    if (outputBytes > LARGE_COPY_CONFIRM_BYTES && !await port.confirm(outputBytes, signal)) return refuse('Copy cancelled')
    if (!current()) return refuse('Copy cancelled')
    if (!await reserve((512 << 10) + inputBytes * 2 + outputBytes * 4)) return current() ? refuse('Copy unavailable · the memory budget is full') : refuse('Copy cancelled')
    const text = parts.join('')
    if (utf8ByteLength(text) !== outputBytes || !current()) return refuse('Copy cancelled')
    if (port.verify && !await port.verify(signal)) return refuse('Copy refused · the source changed before the clipboard write')
    if (!current()) return refuse('Copy cancelled')
    if (!await port.write(text)) return refuse('Copy failed · the clipboard write was rejected')
    return current()
  } finally {
    port.cancelWrite()
  }
}
