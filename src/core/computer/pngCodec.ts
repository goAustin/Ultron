/**
 * v3 Phase 4·2 — minimal in-tree PNG codec.
 *
 * Decode: signature check, IHDR + IDAT walk, zlib inflate, scanline filter
 * reversal (5 PNG filter types). Always returns RGBA at 8 bits/channel.
 *
 * Encode: writes a single-IDAT, filter-0 (None), no-interlace PNG. Input is
 * RGBA at 8 bits/channel. Designed for round-tripping screenshots — not for
 * preserving every PNG ancillary chunk.
 *
 * Why in-tree, not `pngjs` / `sharp`:
 * - The Phase 4·2 design forbids new image-processing dependencies.
 * - We only need to decode Playwright's screenshot output (predictable
 *   format) and re-encode after a bbox blackout. ~250 LOC is cheaper than
 *   another supply-chain surface.
 *
 * What this DOESN'T support:
 * - Bit depths other than 8 (Playwright always emits 8).
 * - Interlacing (Adam7) — Playwright doesn't enable it.
 * - Indexed-color (palette) — same.
 * - Ancillary chunks beyond IHDR/IDAT/IEND — silently dropped on round-trip.
 */

import { deflateSync, inflateSync } from 'node:zlib'

export type DecodedPng = {
  readonly width: number
  readonly height: number
  /**
   * Raw RGBA pixel data, row-major. Length === width * height * 4. Each
   * pixel is `[R, G, B, A]` at 8 bits per channel. RGB-only PNGs are
   * widened to RGBA with A=255; grayscale PNGs are widened to RGBA with
   * R=G=B=gray and A=255.
   */
  readonly rgba: Uint8Array
}

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngDecodeError'
  }
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// Color types per PNG spec §11.2.2:
//   0 = grayscale       (1 channel)
//   2 = truecolor RGB   (3 channels)
//   3 = indexed color   (NOT supported — would need PLTE chunk)
//   4 = grayscale+alpha (2 channels)
//   6 = truecolor+alpha (4 channels)
const SUPPORTED_COLOR_TYPES = new Set([0, 2, 4, 6])

function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0: return 1
    case 2: return 3
    case 4: return 2
    case 6: return 4
    default: throw new PngDecodeError(`unsupported color type ${colorType}`)
  }
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodePng(buf: Uint8Array): DecodedPng {
  if (buf.length < PNG_SIGNATURE.length) {
    throw new PngDecodeError('buffer too short for PNG signature')
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new PngDecodeError('invalid PNG signature')
    }
  }

  let offset = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatChunks: Uint8Array[] = []
  let sawIend = false

  while (offset + 8 <= buf.length) {
    const length = readU32BE(buf, offset)
    offset += 4
    const type = String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!)
    offset += 4
    const dataEnd = offset + length
    if (dataEnd + 4 > buf.length) {
      throw new PngDecodeError(`chunk ${type} truncated`)
    }
    const data = buf.subarray(offset, dataEnd)
    offset = dataEnd + 4 // skip CRC; not validating CRCs (Playwright output is trusted)

    if (type === 'IHDR') {
      if (length < 13) throw new PngDecodeError('IHDR too short')
      width = readU32BE(data, 0)
      height = readU32BE(data, 4)
      bitDepth = data[8]!
      colorType = data[9]!
      const compression = data[10]!
      const filterMethod = data[11]!
      interlace = data[12]!
      if (bitDepth !== 8) {
        throw new PngDecodeError(`only 8-bit depth supported; got ${bitDepth}`)
      }
      if (!SUPPORTED_COLOR_TYPES.has(colorType)) {
        throw new PngDecodeError(`unsupported color type ${colorType}`)
      }
      if (compression !== 0) {
        throw new PngDecodeError(`unsupported compression ${compression}`)
      }
      if (filterMethod !== 0) {
        throw new PngDecodeError(`unsupported filter method ${filterMethod}`)
      }
      if (interlace !== 0) {
        throw new PngDecodeError('interlaced PNGs not supported')
      }
    } else if (type === 'IDAT') {
      idatChunks.push(data.slice())
    } else if (type === 'IEND') {
      sawIend = true
      break
    }
    // Other chunks (PLTE, tRNS, tEXt, ...) are silently ignored.
  }

  if (!sawIend) throw new PngDecodeError('PNG ended without IEND')
  if (width === 0 || height === 0) throw new PngDecodeError('PNG has zero dimensions')
  if (idatChunks.length === 0) throw new PngDecodeError('PNG has no IDAT data')

  const compressed = concat(idatChunks)
  const inflated = new Uint8Array(inflateSync(compressed))

  const channels = channelsForColorType(colorType)
  const bytesPerPixel = channels // bit depth is always 8
  const scanlineLength = width * bytesPerPixel
  const expectedLength = (scanlineLength + 1) * height
  if (inflated.length !== expectedLength) {
    throw new PngDecodeError(
      `inflated data length ${inflated.length} != expected ${expectedLength}`,
    )
  }

  // Filter reversal: produce raw scanlines.
  const raw = new Uint8Array(scanlineLength * height)
  let prevRow: Uint8Array | null = null
  for (let row = 0; row < height; row++) {
    const filterType = inflated[row * (scanlineLength + 1)]!
    const srcStart = row * (scanlineLength + 1) + 1
    const dstStart = row * scanlineLength
    const srcRow = inflated.subarray(srcStart, srcStart + scanlineLength)
    const dstRow = raw.subarray(dstStart, dstStart + scanlineLength)
    reverseFilter(filterType, srcRow, dstRow, prevRow, bytesPerPixel)
    prevRow = dstRow
  }

  // Widen to RGBA.
  const rgba = new Uint8Array(width * height * 4)
  widenToRgba(raw, rgba, channels, width, height)

  return { width, height, rgba }
}

function reverseFilter(
  filterType: number,
  src: Uint8Array,
  dst: Uint8Array,
  prevRow: Uint8Array | null,
  bpp: number,
): void {
  const len = src.length
  switch (filterType) {
    case 0: // None
      dst.set(src)
      return
    case 1: // Sub
      for (let i = 0; i < len; i++) {
        const left = i >= bpp ? dst[i - bpp]! : 0
        dst[i] = (src[i]! + left) & 0xff
      }
      return
    case 2: // Up
      for (let i = 0; i < len; i++) {
        const up = prevRow !== null ? prevRow[i]! : 0
        dst[i] = (src[i]! + up) & 0xff
      }
      return
    case 3: // Average
      for (let i = 0; i < len; i++) {
        const left = i >= bpp ? dst[i - bpp]! : 0
        const up = prevRow !== null ? prevRow[i]! : 0
        dst[i] = (src[i]! + ((left + up) >> 1)) & 0xff
      }
      return
    case 4: // Paeth
      for (let i = 0; i < len; i++) {
        const left = i >= bpp ? dst[i - bpp]! : 0
        const up = prevRow !== null ? prevRow[i]! : 0
        const upLeft = prevRow !== null && i >= bpp ? prevRow[i - bpp]! : 0
        dst[i] = (src[i]! + paeth(left, up, upLeft)) & 0xff
      }
      return
    default:
      throw new PngDecodeError(`unsupported filter type ${filterType}`)
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function widenToRgba(
  raw: Uint8Array,
  rgba: Uint8Array,
  channels: number,
  width: number,
  height: number,
): void {
  const pixels = width * height
  if (channels === 4) {
    rgba.set(raw)
    return
  }
  for (let i = 0; i < pixels; i++) {
    const srcOff = i * channels
    const dstOff = i * 4
    if (channels === 3) {
      rgba[dstOff] = raw[srcOff]!
      rgba[dstOff + 1] = raw[srcOff + 1]!
      rgba[dstOff + 2] = raw[srcOff + 2]!
      rgba[dstOff + 3] = 255
    } else if (channels === 2) {
      const gray = raw[srcOff]!
      rgba[dstOff] = gray
      rgba[dstOff + 1] = gray
      rgba[dstOff + 2] = gray
      rgba[dstOff + 3] = raw[srcOff + 1]!
    } else {
      // grayscale, channels === 1
      const gray = raw[srcOff]!
      rgba[dstOff] = gray
      rgba[dstOff + 1] = gray
      rgba[dstOff + 2] = gray
      rgba[dstOff + 3] = 255
    }
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: rgba length ${rgba.length} != ${width * height * 4}`)
  }
  // Build raw scanlines with filter type 0 (None) prepended to each.
  const scanlineLen = width * 4
  const filtered = new Uint8Array((scanlineLen + 1) * height)
  for (let row = 0; row < height; row++) {
    filtered[row * (scanlineLen + 1)] = 0 // filter: None
    const srcStart = row * scanlineLen
    const dstStart = row * (scanlineLen + 1) + 1
    for (let i = 0; i < scanlineLen; i++) {
      filtered[dstStart + i] = rgba[srcStart + i]!
    }
  }

  const compressed = deflateSync(filtered)

  // Build output: signature + IHDR + IDAT + IEND.
  const ihdrData = new Uint8Array(13)
  writeU32BE(ihdrData, 0, width)
  writeU32BE(ihdrData, 4, height)
  ihdrData[8] = 8   // bit depth
  ihdrData[9] = 6   // color type RGBA
  ihdrData[10] = 0  // compression
  ihdrData[11] = 0  // filter method
  ihdrData[12] = 0  // interlace none

  const ihdrChunk = makeChunk('IHDR', ihdrData)
  const idatChunk = makeChunk('IDAT', compressed)
  const iendChunk = makeChunk('IEND', new Uint8Array(0))

  const total = PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  const out = new Uint8Array(total)
  let off = 0
  out.set(PNG_SIGNATURE, off); off += PNG_SIGNATURE.length
  out.set(ihdrChunk, off); off += ihdrChunk.length
  out.set(idatChunk, off); off += idatChunk.length
  out.set(iendChunk, off)
  return out
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error('chunk type must be 4 chars')
  const out = new Uint8Array(12 + data.length)
  writeU32BE(out, 0, data.length)
  out[4] = type.charCodeAt(0)
  out[5] = type.charCodeAt(1)
  out[6] = type.charCodeAt(2)
  out[7] = type.charCodeAt(3)
  out.set(data, 8)
  // CRC over type + data.
  const crcInput = out.subarray(4, 8 + data.length)
  const crc = crc32(crcInput)
  writeU32BE(out, 8 + data.length, crc)
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readU32BE(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! << 24) |
    (buf[off + 1]! << 16) |
    (buf[off + 2]! << 8) |
    buf[off + 3]!
  ) >>> 0
}

function writeU32BE(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff
  buf[off + 1] = (value >>> 16) & 0xff
  buf[off + 2] = (value >>> 8) & 0xff
  buf[off + 3] = value & 0xff
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// CRC32 — PNG-spec table-driven implementation. Computed lazily on first use.
let crcTable: Uint32Array | null = null
function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(buf: Uint8Array): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}
