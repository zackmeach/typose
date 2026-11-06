// Minimal static fixtures matching the native adapters' supported profiles. No image tool or browser encoder.
import { crc32, deflateSync } from 'node:zlib'

function chunk(kind: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(kind), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([size, body, crc])
}

/** `noise`: incompressible pixels, so the file takes about 3 × width × height bytes, as a screenshot does. */
export function imagePng(width = 1, height = 1, noise = false): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((3 * width + 1) * height)
  for (let y = 0; y < height; y++) {
    const start = y * (3 * width + 1)
    for (let x = 0; x < width; x++) {
      pixels[start + 1 + 3 * x] = (x + y) % 256
      pixels[start + 2 + 3 * x] = 80
      pixels[start + 3 + 3 * x] = 160
    }
  }
  for (let i = 0, state = 0x9e3779b9; noise && i < pixels.length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    if (i % (3 * width + 1)) pixels[i] = state // its low byte; each row's filter byte stays 0
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export const imageGif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex')

export function imageJpeg(width = 1, height = 1): Buffer {
  const data = [255, 216, 255, 219, 0, 67, 0, ...Array<number>(64).fill(1), 255, 192, 0, 11, 8, height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 17, 0]
  for (const kind of [0, 16]) data.push(255, 196, 0, 20, kind, 1, ...Array<number>(15).fill(0), 0)
  data.push(255, 218, 0, 8, 1, 1, 0, 0, 63, 0)
  const bits = 2 * Math.ceil(width / 8) * Math.ceil(height / 8)
  for (let at = 0; at < bits; at += 8) data.push(at + 8 <= bits ? 0 : (1 << (8 - (bits % 8))) - 1)
  data.push(255, 217)
  return Buffer.from(data)
}

// image-webp 0.2.4's decoder.rs decode_2x2_single_color_image, also used by the native regression.
export const imageWebp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x3c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x30, 0, 0, 0, 0xd0, 1,
  0, 0x9d, 1, 0x2a, 2, 0, 2, 0, 2, 0, 0x34, 0x25, 0xa0, 2, 0x74, 0xba, 1, 0xf8, 0, 3, 0xb0, 0, 0xfe, 0xf0, 0xc4,
  0x0b, 0xff, 0x20, 0xb9, 0x61, 0x75, 0xc8, 0xd7, 0xff, 0x20, 0x3f, 0xe4, 7, 0xfc, 0x80, 0xff, 0xf8, 0xf2, 0, 0, 0
])
