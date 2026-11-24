import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { hashImage, sniffImageType, type AssetImage } from '../../modules/assets/asset.image.js';
import { recordAudit } from '../audit.js';
import type { CreateBundleInput, UpdateBundleInput } from './admin-bundle.schemas.js';

/// Une image de couverture se regarde en vignette et sur une page d'article :
/// deux megaoctets suffisent largement, et chaque appareil la telecharge.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface AdminBundleEntry {
  kind: 'asset' | 'scenario';
  /// L'article `asset`, ou le scenario.
  id: string;
  title: string;
  /// Un contenu peut etre retire de la vente : le bundle le donne quand meme,
  /// mais l'ecran le dit.
  available: boolean;
}

export interface AdminBundle {
  itemId: string;
  title: string;
  description: string;
  priceCents: number;
  available: boolean;
  imageHash: string | null;
  owners: number;
  contents: AdminBundleEntry[];
  updatedAt: string;
}

const bundleInclude = {
  _count: { select: { ownerships: true } },
  bundleEntries: {
    orderBy: { sortOrder: 'asc' },
    include: {
      assetItem: { select: { id: true, title: true, available: true } },
      scenario: { select: { id: true, title: true, shopItems: { select: { available: true } } } },
    },
  },
} as const satisfies Prisma.ShopItemInclude;

type BundleRow = Prisma.ShopItemGetPayload<{ include: typeof bundleInclude }>;

/// Les bundles de la boutique : un article qui donne, d'un coup, des assets et
/// des scenarios qui existent deja.
///
/// Comme les autres articles, un bundle ne se supprime pas : il se retire de la
/// vente, et reste a ceux qui l'ont. Changer son contenu ne reprend rien a ceux
/// qui l'ont deja obtenu, et ne leur donne pas non plus ce qui s'y ajoute.
export class AdminBundleService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AdminBundle[]> {
    const rows = await this.prisma.shopItem.findMany({
      where: { type: 'bundle' },
      include: bundleInclude,
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
    return rows.map(toAdminBundle);
  }

  async detail(itemId: string): Promise<AdminBundle> {
    return toAdminBundle(await this.requireBundle(itemId));
  }

  async image(itemId: string): Promise<AssetImage> {
    const row = await this.requireBundle(itemId);
    if (!row.image || !row.imageType || !row.imageHash) {
      throw notFound("Ce bundle n'a pas d'image");
    }
    return { bytes: Buffer.from(row.image), type: row.imageType, hash: row.imageHash };
  }

  async create(adminId: string, input: CreateBundleInput): Promise<AdminBundle> {
    const image = decodeImage(input.image);
    await this.assertContents(input.assetItemIds, input.scenarioIds);
    const last = await this.prisma.shopItem.aggregate({ _max: { sortOrder: true } });

    const created = await this.prisma.$transaction(async (tx) => {
      const item = await tx.shopItem.create({
        data: {
          title: input.title,
          type: 'bundle',
          description: input.description,
          priceCents: input.priceCents,
          imageKey: 'bundle',
          image: new Uint8Array(image.bytes),
          imageType: image.type,
          imageHash: image.hash,
          available: input.available,
          sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
      });

      await writeContents(tx, item.id, input.assetItemIds, input.scenarioIds);

      await recordAudit(tx, {
        adminId,
        action: 'bundle.create',
        targetType: 'shop_item',
        targetId: item.id,
        details: {
          title: input.title,
          assets: input.assetItemIds.length,
          scenarios: input.scenarioIds.length,
          available: input.available,
        },
      });

      return item;
    });

    return this.detail(created.id);
  }

  async update(itemId: string, adminId: string, input: UpdateBundleInput): Promise<AdminBundle> {
    const bundle = await this.requireBundle(itemId);
    const image = input.image === undefined ? null : decodeImage(input.image);

    // Le contenu se remplace d'un bloc : l'ecran envoie toujours les deux
    // listes ensemble, et un seul des deux cotes garderait l'autre tel quel.
    const assetItemIds =
      input.assetItemIds ??
      bundle.bundleEntries.flatMap((entry) => (entry.assetItemId ? [entry.assetItemId] : []));
    const scenarioIds =
      input.scenarioIds ??
      bundle.bundleEntries.flatMap((entry) => (entry.scenarioId ? [entry.scenarioId] : []));
    const contentsChanged = input.assetItemIds !== undefined || input.scenarioIds !== undefined;

    if (contentsChanged) {
      await this.assertContents(assetItemIds, scenarioIds);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shopItem.update({
        where: { id: itemId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
          ...(input.available !== undefined ? { available: input.available } : {}),
          ...(image
            ? {
                image: new Uint8Array(image.bytes),
                imageType: image.type,
                imageHash: image.hash,
              }
            : {}),
        },
      });

      if (contentsChanged) {
        await tx.shopBundleEntry.deleteMany({ where: { bundleId: itemId } });
        await writeContents(tx, itemId, assetItemIds, scenarioIds);
      }

      await recordAudit(tx, {
        adminId,
        action: 'bundle.update',
        targetType: 'shop_item',
        targetId: itemId,
        details: {
          fields: Object.keys(input),
          ...(contentsChanged
            ? { assets: assetItemIds.length, scenarios: scenarioIds.length }
            : {}),
          ...(input.available !== undefined ? { available: input.available } : {}),
        },
      });
    });

    return this.detail(itemId);
  }

  /// Un bundle reunit ce qui existe : un identifiant inconnu, ou un article qui
  /// n'est pas un asset, est une erreur de l'ecran a dire tout de suite.
  private async assertContents(assetItemIds: string[], scenarioIds: string[]): Promise<void> {
    if (new Set(assetItemIds).size !== assetItemIds.length) {
      throw badRequest('Un asset figure deux fois dans le bundle');
    }
    if (new Set(scenarioIds).size !== scenarioIds.length) {
      throw badRequest('Un scenario figure deux fois dans le bundle');
    }

    const [assets, scenarios] = await Promise.all([
      this.prisma.shopItem.count({ where: { id: { in: assetItemIds }, type: 'asset' } }),
      this.prisma.scenario.count({ where: { id: { in: scenarioIds } } }),
    ]);

    if (assets !== assetItemIds.length) {
      throw badRequest("Un des assets choisis n'existe pas");
    }
    if (scenarios !== scenarioIds.length) {
      throw badRequest("Un des scenarios choisis n'existe pas");
    }
  }

  private async requireBundle(itemId: string): Promise<BundleRow> {
    const row = await this.prisma.shopItem.findFirst({
      where: { id: itemId, type: 'bundle' },
      include: bundleInclude,
    });
    if (!row) {
      throw notFound('Bundle introuvable');
    }
    return row;
  }
}

async function writeContents(
  tx: Prisma.TransactionClient,
  bundleId: string,
  assetItemIds: string[],
  scenarioIds: string[],
): Promise<void> {
  await tx.shopBundleEntry.createMany({
    data: [
      ...assetItemIds.map((assetItemId, index) => ({ bundleId, assetItemId, sortOrder: index })),
      ...scenarioIds.map((scenarioId, index) => ({
        bundleId,
        scenarioId,
        sortOrder: assetItemIds.length + index,
      })),
    ],
  });
}

function toAdminBundle(row: BundleRow): AdminBundle {
  return {
    itemId: row.id,
    title: row.title,
    description: row.description,
    priceCents: row.priceCents,
    available: row.available,
    imageHash: row.imageHash,
    owners: row._count.ownerships,
    contents: row.bundleEntries.map((entry): AdminBundleEntry =>
      entry.assetItem
        ? {
            kind: 'asset',
            id: entry.assetItem.id,
            title: entry.assetItem.title,
            available: entry.assetItem.available,
          }
        : {
            kind: 'scenario',
            id: entry.scenario?.id ?? '',
            title: entry.scenario?.title ?? '',
            // Un scenario se vend par ses articles : sans article en vente,
            // le bundle est le seul moyen de l'obtenir.
            available: entry.scenario?.shopItems.some((item) => item.available) ?? false,
          },
    ),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function decodeImage(base64: string): AssetImage {
  const bytes = Buffer.from(base64, 'base64');

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw badRequest(`L'image depasse ${MAX_IMAGE_BYTES / 1024 / 1024} Mo`);
  }

  const type = sniffImageType(bytes);
  if (!type) {
    throw badRequest("L'image doit etre un PNG, un JPEG ou un WebP");
  }

  return { bytes, type, hash: hashImage(bytes) };
}
