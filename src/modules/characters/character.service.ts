import { randomUUID } from 'node:crypto';
import type {
  Character,
  CharacterResource,
  CharacterStat,
  InventoryItem,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { conflict, notFound } from '../../lib/errors.js';
import type {
  CreateCharacterInput,
  PatchCharacterInput,
  PatchInventoryItemInput,
  PutCharacterInput,
  InventoryItemInput,
} from './character.schemas.js';

type CharacterWithChildren = Character & {
  stats: CharacterStat[];
  resources: CharacterResource[];
  inventory: InventoryItem[];
};

const childrenInclude = {
  stats: { orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] },
  resources: { orderBy: { key: 'asc' } },
  inventory: { orderBy: { name: 'asc' } },
} satisfies Prisma.CharacterInclude;

export interface CharacterDto {
  id: string;
  systemId: string;
  name: string;
  occupation: string | null;
  description: string | null;
  level: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  stats: Array<{
    id: string;
    kind: string;
    key: string;
    label: string;
    value: number;
    base: string | null;
    sortOrder: number;
  }>;
  resources: Array<{
    id: string;
    key: string;
    label: string;
    current: number;
    max: number;
    tone: string;
  }>;
  inventory: Array<{
    id: string;
    name: string;
    qty: number;
    weight: string | null;
  }>;
}

export function toCharacterDto(row: CharacterWithChildren): CharacterDto {
  return {
    id: row.id,
    systemId: row.systemId,
    name: row.name,
    occupation: row.occupation,
    description: row.description,
    level: row.level,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    stats: row.stats.map((stat) => ({
      id: stat.id,
      kind: stat.kind,
      key: stat.key,
      label: stat.label,
      value: stat.value,
      base: stat.base,
      sortOrder: stat.sortOrder,
    })),
    resources: row.resources.map((resource) => ({
      id: resource.id,
      key: resource.key,
      label: resource.label,
      current: resource.current,
      max: resource.max,
      tone: resource.tone,
    })),
    inventory: row.inventory.map((item) => ({
      id: item.id,
      name: item.name,
      qty: item.qty,
      weight: item.weight,
    })),
  };
}

/// Reads a sheet **without any ownership check**, for callers that have
/// established their own right to see it by another route. Today the only such
/// caller is the sessions module, where sharing a session with the character's
/// owner is what grants the read (see `session.service.ts`). Every other path
/// must go through `CharacterService`, which scopes by owner.
export async function readSharedCharacter(
  prisma: PrismaClient,
  id: string,
): Promise<CharacterDto | null> {
  const row = await prisma.character.findFirst({
    where: { id, deletedAt: null },
    include: childrenInclude,
  });

  return row ? toCharacterDto(row) : null;
}

export class CharacterService {
  constructor(private readonly prisma: PrismaClient) {}

  /// Without `since`, returns the user's live characters. With `since`, returns
  /// everything touched after that instant *including tombstones*, which is
  /// what an incremental pull needs to replicate deletions.
  async list(userId: string, since?: Date): Promise<CharacterDto[]> {
    const rows = await this.prisma.character.findMany({
      where: {
        userId,
        ...(since ? { updatedAt: { gt: since } } : { deletedAt: null }),
      },
      include: childrenInclude,
      orderBy: { updatedAt: 'asc' },
    });

    return rows.map(toCharacterDto);
  }

  async get(userId: string, id: string): Promise<CharacterDto> {
    return toCharacterDto(await this.requireOwned(userId, id));
  }

  async create(userId: string, input: CreateCharacterInput): Promise<CharacterDto> {
    const id = input.id ?? randomUUID();

    await this.assertIdAvailable(userId, id);

    const now = new Date();
    const createdAt = input.createdAt ? new Date(input.createdAt) : now;

    const row = await this.prisma.character.create({
      data: {
        id,
        userId,
        systemId: input.systemId,
        name: input.name,
        occupation: input.occupation ?? null,
        description: input.description ?? null,
        level: input.level,
        createdAt,
        updatedAt: now,
        stats: { create: input.stats.map((stat) => this.statCreate(stat)) },
        resources: {
          create: input.resources.map((resource) => this.resourceCreate(resource)),
        },
        inventory: { create: input.inventory.map((item) => this.itemCreate(item)) },
      },
      include: childrenInclude,
    });

    return toCharacterDto(row);
  }

  /// Sync push. The whole aggregate is replaced in one transaction; children
  /// are wiped and re-inserted rather than diffed, which keeps the client free
  /// to reorder or rename stats without us guessing at intent.
  async replace(
    userId: string,
    id: string,
    input: PutCharacterInput,
  ): Promise<{ character: CharacterDto; created: boolean }> {
    const existing = await this.prisma.character.findUnique({
      where: { id },
      include: childrenInclude,
    });

    if (existing && existing.userId !== userId) {
      throw conflict('This character id already belongs to another account');
    }

    const incomingUpdatedAt = new Date(input.updatedAt);

    // Last-write-wins: a push carrying an older timestamp than what we already
    // hold is refused, and the winning version travels back in the error so the
    // client can adopt it without a second round trip.
    if (existing && incomingUpdatedAt <= existing.updatedAt) {
      throw conflict('Stale write: the server holds a newer version', {
        character: toCharacterDto(existing),
      });
    }

    const data = {
      systemId: input.systemId,
      name: input.name,
      occupation: input.occupation ?? null,
      description: input.description ?? null,
      level: input.level,
      createdAt: new Date(input.createdAt),
      updatedAt: incomingUpdatedAt,
      deletedAt: input.deletedAt ? new Date(input.deletedAt) : null,
    };

    const row = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.characterStat.deleteMany({ where: { characterId: id } });
        await tx.characterResource.deleteMany({ where: { characterId: id } });
        await tx.inventoryItem.deleteMany({ where: { characterId: id } });
        await tx.character.update({ where: { id }, data });
      } else {
        await tx.character.create({ data: { id, userId, ...data } });
      }

      await tx.characterStat.createMany({
        data: input.stats.map((stat) => ({ characterId: id, ...this.statCreate(stat) })),
      });
      await tx.characterResource.createMany({
        data: input.resources.map((resource) => ({
          characterId: id,
          ...this.resourceCreate(resource),
        })),
      });
      await tx.inventoryItem.createMany({
        data: input.inventory.map((item) => ({
          characterId: id,
          ...this.itemCreate(item),
        })),
      });

      return tx.character.findUniqueOrThrow({ where: { id }, include: childrenInclude });
    });

    return { character: toCharacterDto(row), created: existing === null };
  }

  async patch(
    userId: string,
    id: string,
    input: PatchCharacterInput,
  ): Promise<CharacterDto> {
    await this.requireOwned(userId, id);

    const row = await this.prisma.character.update({
      where: { id },
      data: { ...input, updatedAt: new Date() },
      include: childrenInclude,
    });

    return toCharacterDto(row);
  }

  /// Tombstone rather than a real delete, so other devices can replicate the
  /// removal on their next incremental pull.
  async softDelete(userId: string, id: string): Promise<void> {
    await this.requireOwned(userId, id);

    const now = new Date();
    await this.prisma.character.update({
      where: { id },
      data: { deletedAt: now, updatedAt: now },
    });
  }

  async addInventoryItem(
    userId: string,
    characterId: string,
    input: InventoryItemInput,
  ): Promise<CharacterDto['inventory'][number]> {
    await this.requireOwned(userId, characterId);

    const item = await this.prisma.inventoryItem.create({
      data: { characterId, ...this.itemCreate(input) },
    });
    await this.touch(characterId);

    return { id: item.id, name: item.name, qty: item.qty, weight: item.weight };
  }

  async updateInventoryItem(
    userId: string,
    characterId: string,
    itemId: string,
    input: PatchInventoryItemInput,
  ): Promise<CharacterDto['inventory'][number]> {
    await this.requireOwned(userId, characterId);
    await this.requireItem(characterId, itemId);

    const item = await this.prisma.inventoryItem.update({
      where: { id: itemId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.qty !== undefined ? { qty: input.qty } : {}),
        ...(input.weight !== undefined ? { weight: input.weight ?? null } : {}),
      },
    });
    await this.touch(characterId);

    return { id: item.id, name: item.name, qty: item.qty, weight: item.weight };
  }

  async removeInventoryItem(
    userId: string,
    characterId: string,
    itemId: string,
  ): Promise<void> {
    await this.requireOwned(userId, characterId);
    await this.requireItem(characterId, itemId);

    await this.prisma.inventoryItem.delete({ where: { id: itemId } });
    await this.touch(characterId);
  }

  async setStatValue(
    userId: string,
    characterId: string,
    kind: string,
    key: string,
    value: number,
  ): Promise<CharacterDto['stats'][number]> {
    await this.requireOwned(userId, characterId);

    const existing = await this.prisma.characterStat.findUnique({
      where: { characterId_kind_key: { characterId, kind, key } },
    });
    if (!existing) {
      throw notFound(`No ${kind} named "${key}" on this character`);
    }

    const stat = await this.prisma.characterStat.update({
      where: { id: existing.id },
      data: { value },
    });
    await this.touch(characterId);

    return {
      id: stat.id,
      kind: stat.kind,
      key: stat.key,
      label: stat.label,
      value: stat.value,
      base: stat.base,
      sortOrder: stat.sortOrder,
    };
  }

  async setResourceValue(
    userId: string,
    characterId: string,
    key: string,
    input: { current?: number; max?: number },
  ): Promise<CharacterDto['resources'][number]> {
    await this.requireOwned(userId, characterId);

    const existing = await this.prisma.characterResource.findUnique({
      where: { characterId_key: { characterId, key } },
    });
    if (!existing) {
      throw notFound(`No resource named "${key}" on this character`);
    }

    const max = input.max ?? existing.max;
    // Clamping here as well as in the app keeps the invariant true even for a
    // direct API caller that skips the Flutter client entirely.
    const current = Math.min(Math.max(input.current ?? existing.current, 0), max);

    const resource = await this.prisma.characterResource.update({
      where: { id: existing.id },
      data: { current, max },
    });
    await this.touch(characterId);

    return {
      id: resource.id,
      key: resource.key,
      label: resource.label,
      current: resource.current,
      max: resource.max,
      tone: resource.tone,
    };
  }

  private async requireOwned(
    userId: string,
    id: string,
  ): Promise<CharacterWithChildren> {
    const row = await this.prisma.character.findFirst({
      where: { id, userId, deletedAt: null },
      include: childrenInclude,
    });

    // 404 rather than 403 on someone else's character: a caller must not be
    // able to probe which ids exist.
    if (!row) {
      throw notFound('Character not found');
    }

    return row;
  }

  private async requireItem(characterId: string, itemId: string): Promise<void> {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id: itemId, characterId },
    });
    if (!item) {
      throw notFound('Inventory item not found');
    }
  }

  private async assertIdAvailable(userId: string, id: string): Promise<void> {
    const existing = await this.prisma.character.findUnique({ where: { id } });
    if (!existing) {
      return;
    }
    throw conflict(
      existing.userId === userId
        ? 'A character with this id already exists'
        : 'This character id already belongs to another account',
    );
  }

  /// Any change to a child must move the aggregate's clock, otherwise an
  /// incremental pull on another device would never see it.
  private async touch(characterId: string): Promise<void> {
    await this.prisma.character.update({
      where: { id: characterId },
      data: { updatedAt: new Date() },
    });
  }

  private statCreate(stat: {
    id?: string;
    kind: string;
    key: string;
    label: string;
    value: number;
    base?: string | null;
    sortOrder: number;
  }) {
    return {
      id: stat.id ?? randomUUID(),
      kind: stat.kind,
      key: stat.key,
      label: stat.label,
      value: stat.value,
      base: stat.base ?? null,
      sortOrder: stat.sortOrder,
    };
  }

  private resourceCreate(resource: {
    id?: string;
    key: string;
    label: string;
    current: number;
    max: number;
    tone: string;
  }) {
    return {
      id: resource.id ?? randomUUID(),
      key: resource.key,
      label: resource.label,
      current: resource.current,
      max: resource.max,
      tone: resource.tone,
    };
  }

  private itemCreate(item: {
    id?: string;
    name: string;
    qty: number;
    weight?: string | null;
  }) {
    return {
      id: item.id ?? randomUUID(),
      name: item.name,
      qty: item.qty,
      weight: item.weight ?? null,
    };
  }
}
