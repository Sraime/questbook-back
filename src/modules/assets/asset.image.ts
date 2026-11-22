import { createHash } from 'node:crypto';

/// A token is a small picture drawn in a circle the size of a fingertip. Two
/// megabytes is already generous, and every device downloads every asset.
export const MAX_ASSET_IMAGE_BYTES = 2 * 1024 * 1024;

export interface AssetImage {
  bytes: Buffer;
  type: string;
  hash: string;
}

export const assetKinds = ['character', 'environment', 'effect'] as const;
export type AssetKind = (typeof assetKinds)[number];

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

export function hashImage(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
