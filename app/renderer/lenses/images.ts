import type { ImageRef, Opened, PreparedImage } from '../../shared/protocol'
import { type CoreClient, CoreCallError } from '../core'
import type { LensBudget } from './lens-budget'

const CHUNK = 256 << 10
const MAX_FILE = 8 << 20
const MAX_PIXELS = 16_777_216
/** Kept in sync with md.rs's generated image-label allowance. */
const REASON_UNITS = 256

interface ImageSlot {
  node: HTMLElement
  src: string
  alt: string
  near: boolean
  status: 'waiting' | 'loading' | 'shown' | 'refused'
  reserved: number
  image?: HTMLImageElement
  url?: string
}

/** Encoded host backing, wire, received chunks, Blob storage and decoder input; two bitmap/cache copies. */
const imageCharge = (image: Pick<PreparedImage, 'encodedBytes' | 'pixelBytes'>): number =>
  5 * image.encodedBytes + 2 * image.pixelBytes

/** A generation's images. Loaded blobs and their allowance stay with its retained Rendered tree. */
export class RenderedImages {
  private readonly slots = new Map<HTMLElement, ImageSlot>()
  private readonly active = new Set<AbortController>()
  private readonly observer: IntersectionObserver
  private paused = false
  private stopped = false

  constructor(
    scroller: HTMLElement,
    private readonly core: CoreClient,
    private readonly opened: Opened,
    private readonly budget: LensBudget | undefined,
    private readonly onFrozen: (why: string) => void
  ) {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const slot = this.slots.get(entry.target as HTMLElement)
        if (slot) slot.near = entry.isIntersecting
      }
      this.pump()
    }, { root: scroller, rootMargin: '600px 0px' })
  }

  add(node: HTMLElement): void {
    const src = node.getAttribute('data-src') ?? ''
    const alt = node.getAttribute('data-alt') ?? ''
    const slot: ImageSlot = { node, src, alt, near: false, status: 'waiting', reserved: 0 }
    this.slots.set(node, slot)
    this.label(slot, 'Image not loaded')
    if (!src) return this.refuse(slot, 'Unsupported image target')
    if (/^https?:/i.test(src.trim())) return this.refuse(slot, 'Remote image not loaded')
    this.observer.observe(node)
  }

  pause(): void {
    this.paused = true
    this.observer.disconnect()
    // At most two already activated loads finish into the retained hidden tree. Reusing them avoids allocating
    // another Blob/bitmap on every lens switch while the old objects await collection.
    for (const slot of this.slots.values()) slot.near = false
  }

  resume(): void {
    this.paused = false
    for (const slot of this.slots.values()) if (slot.status === 'waiting') this.observer.observe(slot.node)
    this.pump()
  }

  dispose(): void {
    this.stopped = true
    this.observer.disconnect()
    for (const abort of this.active) abort.abort()
    for (const slot of this.slots.values()) {
      slot.image?.removeAttribute('src')
      if (slot.url) URL.revokeObjectURL(slot.url)
      slot.image?.remove()
    }
    this.slots.clear()
  }

  private label(slot: ImageSlot, reason: string): void {
    slot.node.textContent = `${slot.alt || 'Image'} · ${reason.slice(0, REASON_UNITS)}`
  }

  private refuse(slot: ImageSlot, reason: string): void {
    slot.status = 'refused'
    this.observer.unobserve(slot.node)
    this.label(slot, reason)
  }

  private pump(): void {
    if (this.stopped || this.paused) return
    for (const slot of this.slots.values()) {
      if (this.active.size >= 2) return
      if (!slot.near || slot.status !== 'waiting') continue
      slot.status = 'loading'
      this.observer.unobserve(slot.node)
      const abort = new AbortController()
      this.active.add(abort)
      void this.load(slot, abort).finally(() => {
        this.active.delete(abort)
        this.pump()
      })
    }
  }

  private refIsCurrent(ref: ImageRef): boolean {
    return !!this.budget && !!ref && ref.session === this.budget.session && ref.doc === this.opened.doc && ref.gen === this.opened.gen && Number.isSafeInteger(ref.id) && ref.id >= 1
  }

  private valid(image: PreparedImage): boolean {
    const { width, height, encodedBytes, pixelBytes } = image
    return this.refIsCurrent(image.ref) && Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 &&
      width * height <= MAX_PIXELS && Number.isSafeInteger(encodedBytes) && encodedBytes > 0 && encodedBytes <= MAX_FILE && pixelBytes === 4 * width * height
  }

  private async release(ref: ImageRef): Promise<void> {
    if (!this.refIsCurrent(ref)) return
    await this.core.call('releaseImage', { doc: this.opened.doc, gen: this.opened.gen, ref }).catch(() => {})
  }

  private async load(slot: ImageSlot, abort: AbortController): Promise<void> {
    let ref: ImageRef | undefined
    try {
      const image = await this.core.call('prepareImage', { doc: this.opened.doc, gen: this.opened.gen, src: slot.src }, abort.signal)
      ref = image.ref
      if (this.stopped) return
      if (!this.valid(image)) throw new Error('Invalid image resource')
      const charge = imageCharge(image)
      if (!this.budget || !await this.budget.growRendered(this.opened.gen, Math.max(0, charge - slot.reserved)))
        throw new Error('Memory budget is full')
      slot.reserved = Math.max(slot.reserved, charge)
      if (this.stopped) return
      // One bounded chunk in flight per image. No file URL or source bytes reach the DOM.
      const chunks: BlobPart[] = []
      for (let offset = 0; offset < image.encodedBytes;) {
        const bytes = await this.core.call('imageChunk', { doc: this.opened.doc, gen: this.opened.gen, ref, offset }, abort.signal)
        if (this.stopped) return
        if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length !== Math.min(CHUNK, image.encodedBytes - offset))
          throw new Error('Invalid image chunk')
        chunks.push(bytes as Uint8Array<ArrayBuffer>)
        offset += bytes.length
      }
      const blob = new Blob(chunks, { type: 'image/png' })
      await this.release(ref)
      ref = undefined
      if (this.stopped) return
      const img = document.createElement('img')
      slot.image = img
      img.alt = slot.alt
      img.width = image.width
      img.height = image.height
      img.decoding = 'async'
      slot.url = URL.createObjectURL(blob)
      img.src = slot.url
      await img.decode()
      if (this.stopped) return
      slot.node.replaceChildren(img)
      slot.node.dataset.loaded = '1'
      slot.status = 'shown'
    } catch (e) {
      if (this.stopped) return
      if (e instanceof CoreCallError && e.code === 'Frozen') this.onFrozen(e.message)
      if (slot.url) {
        slot.image?.removeAttribute('src')
        URL.revokeObjectURL(slot.url)
        slot.url = undefined
      }
      const reason = e instanceof CoreCallError && e.code === 'Memory' ? 'Memory budget is full' : e instanceof Error ? e.message.replace(/^refused: /, '') : 'Image could not be loaded'
      this.refuse(slot, reason)
    } finally {
      if (ref) await this.release(ref)
    }
  }
}
