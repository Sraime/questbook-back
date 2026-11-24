import { describe, expect, it } from 'vitest';
import { imageSize, sniffImageType } from '../src/modules/assets/asset.image.js';

/// Headers written by hand, 300 by 200 pixels: the dimensions are all that
/// is read, the picture itself never is.

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0x01, 0x2c, 0, 0, 0, 0xc8, 8, 6, 0, 0, 0]),
]);

/// An APP0 segment before the frame, as every camera writes one.
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0'),
  Buffer.alloc(9),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03]),
  Buffer.alloc(9),
]);

const riff = (chunk: string, body: Buffer) =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), body]);

const webpLossless = riff('VP8L', Buffer.from([0, 0, 0, 0, 0x2f, 0x2b, 0xc1, 0x31, 0x00]));

const webpExtended = riff(
  'VP8X',
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0x2b, 0x01, 0x00, 0xc7, 0x00, 0x00]),
);

describe('reading the size of an image', () => {
  it.each([
    ['PNG', png],
    ['JPEG', jpeg],
    ['WebP lossless', webpLossless],
    ['WebP extended', webpExtended],
  ])('reads a %s header', (_, bytes) => {
    const type = sniffImageType(bytes);
    expect(type).not.toBeNull();
    expect(imageSize(bytes, type!)).toEqual({ width: 300, height: 200 });
  });

  it('gives up on a truncated header rather than inventing a size', () => {
    expect(imageSize(png.subarray(0, 18), 'image/png')).toBeNull();
    expect(imageSize(jpeg.subarray(0, 24), 'image/jpeg')).toBeNull();
  });
});
