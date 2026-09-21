import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';

/// What a card in the shop shows: a picture, a title, a type and a price.
/// `owned` is what makes the buy button disappear, so it travels with the
/// listing rather than in a call of its own.
export interface ShopItemSummaryDto {
  id: string;
  title: string;
  type: string;
  /// Carried in the listing, not held back for the detail: a `scenario`
  /// article is shown full width with a few lines of what it is about, and
  /// an adventure one cannot read anything about is an adventure nobody
  /// opens. Asset rows ignore it.
  description: string;
  priceCents: number;
  imageKey: string;
  /// Present on `asset` articles. Carried in the summary on purpose: the app
  /// derives the tokens an account may pose from this one listing, rather
  /// than asking again item by item.
  assetKey: string | null;
  owned: boolean;
}

export interface ShopItemDetailDto extends ShopItemSummaryDto {
  scenarioId: string | null;
}

const summarySelect = {
  id: true,
  title: true,
  type: true,
  description: true,
  priceCents: true,
  imageKey: true,
  assetKey: true,
} as const;

const detailSelect = {
  ...summarySelect,
  scenarioId: true,
} as const;

export class ShopService {
  constructor(private readonly prisma: PrismaClient) {}

  /// The whole catalogue, owned or not — unlike scenarios, whose list is only
  /// what you hold. A shop that hid what you have not bought would have
  /// nothing to sell.
  async list(userId: string): Promise<ShopItemSummaryDto[]> {
    const rows = await this.prisma.shopItem.findMany({
      select: {
        ...summarySelect,
        ownerships: { where: { userId }, select: { id: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });

    return rows.map(({ ownerships, ...item }) => ({
      ...item,
      owned: ownerships.length > 0,
    }));
  }

  async get(userId: string, itemId: string): Promise<ShopItemDetailDto> {
    const row = await this.prisma.shopItem.findUnique({
      where: { id: itemId },
      select: {
        ...detailSelect,
        ownerships: { where: { userId }, select: { id: true } },
      },
    });

    if (!row) {
      throw notFound('Shop item not found');
    }

    const { ownerships, ...item } = row;
    return { ...item, owned: ownerships.length > 0 };
  }

  /// Hands the article over. There is no payment yet, so this only writes
  /// ownership down.
  ///
  /// Idempotent rather than a 409 on an article already held: a double tap
  /// must not surface an error, and the day money changes hands that is
  /// exactly the property worth having.
  async purchase(userId: string, itemId: string): Promise<ShopItemDetailDto> {
    const item = await this.prisma.shopItem.findUnique({
      where: { id: itemId },
      select: { id: true, type: true, priceCents: true, scenarioId: true },
    });

    if (!item) {
      throw notFound('Shop item not found');
    }

    // A pack has no content model yet. Letting it through would grant
    // nothing at all while reporting success.
    if (item.type === 'pack') {
      throw badRequest('Packs cannot be purchased yet');
    }

    // The free article is the only one there is until payment exists.
    // Without this, a priced article would be given away.
    if (item.priceCents > 0) {
      throw badRequest('Payment is not available yet');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shopItemOwnership.createMany({
        data: [{ userId, itemId: item.id, source: 'purchase' }],
        skipDuplicates: true,
      });

      // Reading an adventure stays gated by `ScenarioOwnership`, so buying
      // one writes there too: nothing downstream has to learn about the shop.
      if (item.type === 'scenario' && item.scenarioId) {
        await tx.scenarioOwnership.createMany({
          data: [{ userId, scenarioId: item.scenarioId, source: 'purchase' }],
          skipDuplicates: true,
        });
      }
    });

    return this.get(userId, item.id);
  }
}
