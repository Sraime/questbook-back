import { createHash } from 'node:crypto';

export interface AssetImage {
  bytes: Buffer;
  type: string;
  hash: string;
}

export const assetKinds = ['character', 'environment', 'effect', 'map'] as const;
export type AssetKind = (typeof assetKinds)[number];

/// A token is a small picture drawn in a circle the size of a fingertip: two
/// megabytes is already generous, and every device downloads every asset. A
/// map fills the whole board and is looked at closely, so it gets more room.
export function maxImageBytes(kind: AssetKind): number {
  return (kind === 'map' ? 5 : 2) * 1024 * 1024;
}
/// The type is read from the first bytes, never taken from the uploader's
/// word: whatever is stored here is later served to every player with that
/// content type.
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/// Width and height in pixels, read from the header rather than by decoding
/// the picture. `null` when the header cannot be read, which the caller
/// treats as a broken image.
export function imageSize(
  bytes: Buffer,
  type: string,
): { width: number; height: number } | null {
  try {
    const size =
      type === 'image/png'
        ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
        : type === 'image/jpeg'
          ? jpegSize(bytes)
          : type === 'image/webp'
            ? webpSize(bytes)
            : null;
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

export function hashImage(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/// The dimensions sit in the first start-of-frame segment, after however
/// many metadata segments the camera or the editor wrote before it.
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes.readUInt8(at) !== 0xff) return null;
    const marker = bytes.readUInt8(at + 1);
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/// Three encodings share the container, each with its own header.
function webpSize(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8 ') {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [21, 22, 23, 24].map((at) => bytes.readUInt8(at)) as [
      number,
      number,
      number,
      number,
    ];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  return null;
}
