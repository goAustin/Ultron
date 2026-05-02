/**
 * v3 Phase 1: tool-result image attachment substrate.
 *
 * `ToolResultAttachment` is the typed shape a tool returns alongside its text
 * `content` when it wants the model to see an image (e.g., a Computer-Use
 * screenshot). `createToolResultMessage` lays attachments down as adjacent
 * `ImageBlock`s in the same `UserMessage` that carries the `ToolResultBlock` —
 * see `docs/ultron_v3/v3-phase1-design.md` "Internal representation".
 *
 * `validateImageAttachment` is the caps-enforcement entry point: it checks
 * byte size, parses the PNG IHDR for width/height, and rejects anything
 * outside the configured `maxScreenshotBytes` / `maxScreenshotDimensions`.
 * Phase 1 is PNG-only; JPEG support can be added later if a use case
 * demands it.
 *
 * No native image dependency. PNG IHDR is the first chunk after the 8-byte
 * signature; width/height are big-endian uint32s at fixed offsets.
 */

export type ToolResultAttachment = {
  readonly type: 'image'
  readonly mediaType: 'image/png'
  readonly data: string             // base64
  readonly width: number
  readonly height: number
  readonly byteSize: number
  readonly redacted?: boolean
}

export type ImageCaps = {
  readonly maxBytes: number
  readonly maxWidth: number
  readonly maxHeight: number
}

export type ValidateImageResult =
  | { readonly ok: true; readonly attachment: ToolResultAttachment }
  | {
      readonly ok: false
      readonly reason:
        | 'unsupported_media_type'
        | 'malformed_png'
        | 'oversized_bytes'
        | 'oversized_dimensions'
      readonly message: string
    }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
// IHDR chunk: 4-byte length (must be 13), 4-byte type ("IHDR"), 13 bytes data,
// 4-byte CRC. Header is required to be the first chunk; we validate length
// and type before reading width/height so a file with a valid signature but
// arbitrary bytes at offset 16/20 cannot pass validation.
const IHDR_DATA_LENGTH = 13
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52] as const // "IHDR"

function parsePngDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  if (buf.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null
  }
  if (buf.readUInt32BE(8) !== IHDR_DATA_LENGTH) return null
  for (let i = 0; i < IHDR_TYPE.length; i++) {
    if (buf[12 + i] !== IHDR_TYPE[i]) return null
  }
  // IHDR chunk: width (uint32 BE) at byte 16, height (uint32 BE) at byte 20.
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

export function validateImageAttachment(
  data: string,
  mediaType: string,
  caps: ImageCaps,
): ValidateImageResult {
  if (mediaType !== 'image/png') {
    return {
      ok: false,
      reason: 'unsupported_media_type',
      message: `Phase 1 supports only image/png; got ${JSON.stringify(mediaType)}`,
    }
  }

  let buf: Buffer
  try {
    buf = Buffer.from(data, 'base64')
  } catch {
    return { ok: false, reason: 'malformed_png', message: 'base64 decode failed' }
  }

  const byteSize = buf.byteLength
  if (byteSize > caps.maxBytes) {
    return {
      ok: false,
      reason: 'oversized_bytes',
      message: `image is ${byteSize} bytes; cap is ${caps.maxBytes}`,
    }
  }

  const dims = parsePngDimensions(buf)
  if (dims === null) {
    return {
      ok: false,
      reason: 'malformed_png',
      message: 'PNG signature or IHDR chunk missing',
    }
  }

  if (dims.width > caps.maxWidth || dims.height > caps.maxHeight) {
    return {
      ok: false,
      reason: 'oversized_dimensions',
      message: `image is ${dims.width}x${dims.height}; cap is ${caps.maxWidth}x${caps.maxHeight}`,
    }
  }

  return {
    ok: true,
    attachment: {
      type: 'image',
      mediaType: 'image/png',
      data,
      width: dims.width,
      height: dims.height,
      byteSize,
    },
  }
}
