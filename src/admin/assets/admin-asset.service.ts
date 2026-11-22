import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  hashImage,
  MAX_ASSET_IMAGE_BYTES,
  sniffImageType,
  type AssetImage,
} from '../../modules/assets/asset.image.js';
import { recordAudit } from '../audit.js';
import type { CreateAssetInput, UpdateAssetInput } from './admin-asset.schemas.js';

/// Un article `asset` de la boutique, et l'asset qu'il vend.
///
/// Les deux vont ensemble dans cet ecran : on ajoute un pion pour le vendre,
/// et le nom qu'on lui donne est celui de l'article. `hosted` distingue ceux
/// dont le serveur porte l'image de ceux qu'embarque l'app — ces derniers
/// n'ont ni nature ni image ici, seulement une disponibilite.
export interface AdminAsset {
  itemId: string;
  key: string;
  title: string;
  description: string;
  kind: string | null;
  hosted: boolean;
  imageHash: string | null;
  available: boolean;
  owners: number;
  updatedAt: string;
}

const itemInclude = { _count: { select: { ownerships: true } } } as const;

type ItemRow = Prisma.ShopItemGetPayload<{ include: typeof itemInclude }>;
type AssetRow = { key: string; kind: string; imageHash: string };

export class AdminAssetService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AdminAsset[]> {
    const items = await this.prisma.shopItem.findMany({
      where: { type: 'asset' },
      include: itemInclude,
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
    const assets = await this.hostedFor(items);

    return items.map((item) => toAdminAsset(item, assets.get(item.assetKey ?? '')));
  }

  async detail(itemId: string): Promise<AdminAsset> {
    const item = await this.requireItem(itemId);
    const assets = await this.hostedFor([item]);
    return toAdminAsset(item, assets.get(item.assetKey ?? ''));
  }

  async image(itemId: string): Promise<AssetImage> {
    const item = await this.requireItem(itemId);
    const asset = item.assetKey
      ? await this.prisma.asset.findUnique({ where: { key: item.assetKey } })
      : null;

    if (!asset) {
      throw notFound('Cet asset est embarque dans l\'app : le serveur n\'a pas son image');
    }

    return { bytes: Buffer.from(asset.image), type: asset.imageType, hash: asset.imageHash };
  }

  async create(adminId: string, input: CreateAssetInput): Promise<AdminAsset> {
    const image = decodeImage(input.image);
    const key = await this.freeKey(input.name);
    const last = await this.prisma.shopItem.aggregate({ _max: { sortOrder: true } });

    const item = await this.prisma.$transaction(async (tx) => {
      await tx.asset.create({
        data: {
          key,
          name: input.name,
          kind: input.kind,
          image: new Uint8Array(image.bytes),
          imageType: image.type,
          imageHash: image.hash,
        },
      });

      // Gratuit : le paiement n'existe pas encore, et la boutique refuse
      // d'ailleurs de vendre ce qui a un prix.
      const created = await tx.shopItem.create({
        data: {
          title: input.name,
          type: 'asset',
          description: input.description,
          priceCents: 0,
          imageKey: 'asset',
          assetKey: key,
          available: input.available,
          sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
      });

      await recordAudit(tx, {
        adminId,
        action: 'asset.create',
        targetType: 'shop_item',
        targetId: created.id,
        details: { key, name: input.name, kind: input.kind, available: input.available },
      });

      return created;
    });

    return this.detail(item.id);
  }

  async update(itemId: string, adminId: string, input: UpdateAssetInput): Promise<AdminAsset> {
    const item = await this.requireItem(itemId);
    const asset = item.assetKey
      ? await this.prisma.asset.findUnique({
          where: { key: item.assetKey },
          select: { key: true },
        })
      : null;

    // Le dessin d'un asset embarque est dans le binaire de l'app : changer son
    // image ou sa nature ici ne changerait rien a ce que les joueurs voient.
    if (!asset && (input.image !== undefined || input.kind !== undefined)) {
      throw badRequest(
        'Cet asset est embarque dans l\'app : seuls son titre, sa description et sa disponibilite se modifient ici',
      );
    }

    const image = input.image === undefined ? null : decodeImage(input.image);

    await this.prisma.$transaction(async (tx) => {
      await tx.shopItem.update({
        where: { id: itemId },
        data: {
          ...(input.name !== undefined ? { title: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.available !== undefined ? { available: input.available } : {}),
        },
      });

      if (asset) {
        await tx.asset.update({
          where: { key: asset.key },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(image
              ? {
                  image: new Uint8Array(image.bytes),
                  imageType: image.type,
                  imageHash: image.hash,
                }
              : {}),
          },
        });
      }

      await recordAudit(tx, {
        adminId,
        action: 'asset.update',
        targetType: 'shop_item',
        targetId: itemId,
        details: {
          fields: Object.keys(input),
          ...(input.available !== undefined ? { available: input.available } : {}),
        },
      });
    });

    return this.detail(itemId);
  }

  private async requireItem(itemId: string): Promise<ItemRow> {
    const item = await this.prisma.shopItem.findFirst({
      where: { id: itemId, type: 'asset' },
      include: itemInclude,
    });

    if (!item) {
      throw notFound('Asset introuvable');
    }

    return item;
  }

  private async hostedFor(items: ItemRow[]): Promise<Map<string, AssetRow>> {
    const keys = items.flatMap((item) => (item.assetKey ? [item.assetKey] : []));
    const rows = await this.prisma.asset.findMany({
      where: { key: { in: keys } },
      select: { key: true, kind: true, imageHash: true },
    });
    return new Map(rows.map((row) => [row.key, row]));
  }

  /// La cle se tire du nom, une fois pour toutes. Elle ne doit croiser ni un
  /// asset heberge, ni un asset embarque dans l'app, que seule la boutique
  /// connait par sa cle.
  private async freeKey(name: string): Promise<string> {
    const base = slug(name);

    for (let attempt = 1; ; attempt++) {
      const key = attempt === 1 ? base : `${base}_${attempt}`;
      const [asset, item] = await Promise.all([
        this.prisma.asset.findUnique({ where: { key }, select: { key: true } }),
        this.prisma.shopItem.findFirst({ where: { assetKey: key }, select: { id: true } }),
      ]);
      if (!asset && !item) return key;
    }
  }
}

function toAdminAsset(item: ItemRow, asset: AssetRow | undefined): AdminAsset {
  return {
    itemId: item.id,
    key: item.assetKey ?? '',
    title: item.title,
    description: item.description,
    kind: asset?.kind ?? null,
    hosted: asset !== undefined,
    imageHash: asset?.imageHash ?? null,
    available: item.available,
    owners: item._count.ownerships,
    updatedAt: item.updatedAt.toISOString(),
  };
}

function decodeImage(base64: string): AssetImage {
  const bytes = Buffer.from(base64, 'base64');

  if (bytes.length > MAX_ASSET_IMAGE_BYTES) {
    throw badRequest('L\'image depasse 2 Mo');
  }

  const type = sniffImageType(bytes);
  if (!type) {
    throw badRequest('L\'image doit etre un PNG, un JPEG ou un WebP');
  }

  return { bytes, type, hash: hashImage(bytes) };
}

function slug(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return folded.length > 0 ? folded : 'asset';
}
