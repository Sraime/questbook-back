import type { Prisma, PrismaClient } from '@prisma/client';
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
  /// Set when the server hosts the article's own picture, served by
  /// `GET /shop/items/:id/image`. Bundles have one; the app names its cached
  /// copy after this hash, so a new picture is fetched once.
  imageHash: string | null;
  /// Present on `asset` articles. Carried in the summary on purpose: the app
  /// derives the tokens an account may pose from this one listing, rather
  /// than asking again item by item.
  assetKey: string | null;
  /// False once withdrawn. Only an owner still sees such an article.
  available: boolean;
  owned: boolean;
}

/// One thing a bundle hands over, and whether the reader already has it:
/// buying a bundle that overlaps what one owns is allowed, but should not
/// come as a surprise.
export interface ShopBundleEntryDto {
  kind: 'asset' | 'scenario';
  title: string;
  /// The `asset` article, for an asset.
  itemId: string | null;
  assetKey: string | null;
  scenarioId: string | null;
  owned: boolean;
}

export interface ShopItemDetailDto extends ShopItemSummaryDto {
  scenarioId: string | null;
  /// What a bundle contains, in the order the backoffice set. Empty for
  /// any other article.
  contents: ShopBundleEntryDto[];
}

const summarySelect = {
  id: true,
  title: true,
  type: true,
  description: true,
  priceCents: true,
  imageKey: true,
  imageHash: true,
  assetKey: true,
  available: true,
} as const;

const detailSelect = {
  ...summarySelect,
  scenarioId: true,
} as const;

const entriesSelect = (userId: string) =>
  ({
    orderBy: { sortOrder: 'asc' },
    select: {
      assetItem: {
        select: {
          id: true,
          title: true,
          assetKey: true,
          ownerships: { where: { userId }, select: { id: true } },
        },
      },
      scenario: {
        select: {
          id: true,
          title: true,
          ownerships: { where: { userId }, select: { id: true } },
        },
      },
    },
  }) satisfies Prisma.ShopItem$bundleEntriesArgs;

export class ShopService {
  constructor(private readonly prisma: PrismaClient) {}

  /// The whole catalogue, owned or not — unlike scenarios, whose list is only
  /// what you hold. A shop that hid what you have not bought would have
  /// nothing to sell.
  ///
  /// A withdrawn article stays in the list of whoever owns it: the app reads
  /// the tokens an account may pose from this listing, and withdrawing an
  /// article must not take it back from those who have it. That is also how
  /// an asset that only ever came in a bundle reaches its owner's drawer.
  async list(userId: string): Promise<ShopItemSummaryDto[]> {
    const rows = await this.prisma.shopItem.findMany({
      where: { OR: [{ available: true }, { ownerships: { some: { userId } } }] },
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
        bundleEntries: entriesSelect(userId),
      },
    });

    if (!row) {
      throw notFound('Shop item not found');
    }

    const { ownerships, bundleEntries, ...item } = row;
    return {
      ...item,
      owned: ownerships.length > 0,
      contents: bundleEntries.map(({ assetItem, scenario }): ShopBundleEntryDto =>
        assetItem
          ? {
              kind: 'asset',
              title: assetItem.title,
              itemId: assetItem.id,
              assetKey: assetItem.assetKey,
              scenarioId: null,
              owned: assetItem.ownerships.length > 0,
            }
          : {
              kind: 'scenario',
              title: scenario?.title ?? '',
              itemId: null,
              assetKey: null,
              scenarioId: scenario?.id ?? null,
              owned: (scenario?.ownerships.length ?? 0) > 0,
            },
      ),
    };
  }

  /// The article's own picture. Readable by any signed-in account, like the
  /// listing it illustrates.
  async image(itemId: string): Promise<{ bytes: Buffer; type: string; hash: string }> {
    const row = await this.prisma.shopItem.findUnique({
      where: { id: itemId },
      select: { image: true, imageType: true, imageHash: true },
    });

    if (!row?.image || !row.imageType || !row.imageHash) {
      throw notFound('This item has no picture of its own');
    }

    return { bytes: Buffer.from(row.image), type: row.imageType, hash: row.imageHash };
  }

  /// Hands the article over. There is no payment yet, so this only writes
  /// ownership down.
  ///
  /// Idempotent rather than a 409 on an article already held: a double tap
  /// must not surface an error, and the day money changes hands that is
  /// exactly the property worth having. The same goes for a bundle that
  /// overlaps what one has: what is already owned is simply skipped.
  async purchase(userId: string, itemId: string): Promise<ShopItemDetailDto> {
    const item = await this.prisma.shopItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        type: true,
        priceCents: true,
        scenarioId: true,
        available: true,
        ownerships: { where: { userId }, select: { id: true } },
        bundleEntries: { select: { assetItemId: true, scenarioId: true } },
      },
    });

    if (!item) {
      throw notFound('Shop item not found');
    }

    // Already owned stays idempotent: a double tap that lands after the
    // withdrawal must not turn into an error.
    if (!item.available && item.ownerships.length === 0) {
      throw badRequest('This item is no longer for sale');
    }

    // The free article is the only one there is until payment exists.
    // Without this, a priced article would be given away. A bundle's own
    // price is what counts, not that of what it holds.
    if (item.priceCents > 0) {
      throw badRequest('Payment is not available yet');
    }

    const assetItemIds = item.bundleEntries.flatMap((entry) =>
      entry.assetItemId ? [entry.assetItemId] : [],
    );
    const scenarioIds = [
      ...item.bundleEntries.flatMap((entry) => (entry.scenarioId ? [entry.scenarioId] : [])),
      ...(item.type === 'scenario' && item.scenarioId ? [item.scenarioId] : []),
    ];

    await this.prisma.$transaction(async (tx) => {
      await tx.shopItemOwnership.createMany({
        data: [{ userId, itemId: item.id, source: 'purchase' }],
        skipDuplicates: true,
      });

      if (item.type !== 'bundle') {
        // Reading an adventure stays gated by `ScenarioOwnership`, so buying
        // one writes there too: nothing downstream has to learn about the shop.
        if (scenarioIds.length > 0) {
          await tx.scenarioOwnership.createMany({
            data: scenarioIds.map((scenarioId) => ({ userId, scenarioId, source: 'purchase' })),
            skipDuplicates: true,
          });
        }
        return;
      }

      // The articles that sell the bundled adventures are marked owned too,
      // or the shop would go on offering to sell what one already has.
      const scenarioItems =
        scenarioIds.length === 0
          ? []
          : await tx.shopItem.findMany({
              where: { type: 'scenario', scenarioId: { in: scenarioIds } },
              select: { id: true },
            });

      await tx.shopItemOwnership.createMany({
        data: [...assetItemIds, ...scenarioItems.map((row) => row.id)].map((id) => ({
          userId,
          itemId: id,
          source: 'bundle',
        })),
        skipDuplicates: true,
      });

      // `purchase` rather than `bundle`: the backoffice refuses to take back
      // what was paid for, and a bundle was.
      await tx.scenarioOwnership.createMany({
        data: scenarioIds.map((scenarioId) => ({ userId, scenarioId, source: 'purchase' })),
        skipDuplicates: true,
      });
    });

    return this.get(userId, item.id);
  }
}
