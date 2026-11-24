import type { PrismaClient } from '@prisma/client';
import { notFound } from '../../lib/errors.js';
import type { AssetImage } from './asset.image.js';

/// What the app needs to draw a hosted token: its section, its name, and the
/// version of its picture, which names the copy it keeps on the device.
export interface AssetDto {
  key: string;
  name: string;
  kind: string;
  imageHash: string;
  /// In pixels. What a map gives the board as proportions; null only on
  /// tokens hosted before maps existed.
  width: number | null;
  height: number | null;
}

export class AssetService {
  constructor(private readonly prisma: PrismaClient) {}

  /// Every hosted asset, owned or not, available in the shop or not. A
  /// player watches the tokens the game master poses, so drawing one must
  /// never depend on having bought it, nor on it still being on sale.
  async list(): Promise<AssetDto[]> {
    return this.prisma.asset.findMany({
      select: { key: true, name: true, kind: true, imageHash: true, width: true, height: true },
      orderBy: { name: 'asc' },
    });
  }

  async image(key: string): Promise<AssetImage> {
    const row = await this.prisma.asset.findUnique({
      where: { key },
      select: { image: true, imageType: true, imageHash: true },
    });

    if (!row) {
      throw notFound('Asset not found');
    }

    return { bytes: Buffer.from(row.image), type: row.imageType, hash: row.imageHash };
  }
}
