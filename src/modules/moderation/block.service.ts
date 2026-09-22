import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { publicLabel } from '../tables/table.access.js';

export interface BlockedUserDto {
  userId: string;
  displayName: string;
  pictureUrl: string | null;
  blockedAt: string;
}

/// Ce que le blocage a defait, pour que l'app puisse le dire plutot que de
/// laisser deviner.
export interface BlockOutcomeDto {
  block: BlockedUserDto;
  /// Tables qu'on a quittees, parce qu'on n'en menait pas le jeu.
  tablesLeft: number;
  /// Tables dont on a retire l'autre, parce qu'on en est le MJ. Le MJ ne peut
  /// pas partir sans laisser une salle que personne ne peut plus animer.
  playersRemoved: number;
}

export class BlockService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<BlockedUserDto[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: userId },
      include: { blocked: true },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => ({
      userId: row.blockedId,
      displayName: publicLabel(row.blocked),
      pictureUrl: row.blocked.pictureUrl,
      blockedAt: row.createdAt.toISOString(),
    }));
  }

  /// Bloquer n'est pas qu'une promesse sur l'avenir : le geste defait aussi
  /// ce qui existe. Tout se fait dans une transaction — un blocage enregistre
  /// mais laissant les deux comptes a la meme table serait pire que rien.
  async block(userId: string, targetId: string): Promise<BlockOutcomeDto> {
    if (targetId === userId) {
      throw badRequest('On ne se bloque pas soi-même.');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
    });
    if (!target) {
      throw notFound('User not found');
    }

    return this.prisma.$transaction(async (tx) => {
      // Idempotent : bloquer deux fois est le meme blocage, pas une erreur.
      // Les consequences, elles, se rejouent — une table rejointe depuis le
      // premier blocage doit se defaire comme les autres.
      const block = await tx.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } },
        create: { blockerId: userId, blockedId: targetId },
        update: {},
      });

      // Les invitations en attente partent dans les deux sens. Celles qu'il
      // m'a envoyees, c'est la promesse du geste ; les miennes, parce qu'il
      // serait absurde de bloquer quelqu'un tout en l'attendant.
      await tx.tableInvitation.deleteMany({
        where: {
          status: 'pending',
          OR: [
            { invitedUserId: userId, invitedById: targetId },
            { invitedUserId: targetId, invitedById: userId },
          ],
        },
      });

      const shared = await tx.tableMember.findMany({
        where: {
          userId,
          table: { members: { some: { userId: targetId } } },
        },
        select: { tableId: true, role: true },
      });

      // Le MJ ne peut pas quitter sa table : elle resterait sans personne
      // pour organiser quoi que ce soit. C'est l'autre qui en sort.
      const asGameMaster = shared.filter((row) => row.role === 'gm');
      const asPlayer = shared.filter((row) => row.role !== 'gm');

      if (asGameMaster.length > 0) {
        await tx.tableMember.deleteMany({
          where: {
            userId: targetId,
            tableId: { in: asGameMaster.map((row) => row.tableId) },
          },
        });
      }

      if (asPlayer.length > 0) {
        await tx.tableMember.deleteMany({
          where: {
            userId,
            tableId: { in: asPlayer.map((row) => row.tableId) },
          },
        });
      }

      return {
        block: {
          userId: targetId,
          displayName: publicLabel(target),
          pictureUrl: target.pictureUrl,
          blockedAt: block.createdAt.toISOString(),
        },
        tablesLeft: asPlayer.length,
        playersRemoved: asGameMaster.length,
      };
    });
  }

  /// Debloquer ne rend rien : les tables quittees le restent, et il faudra
  /// une nouvelle invitation. C'est le prix du geste, et l'app le dit avant.
  async unblock(userId: string, targetId: string): Promise<void> {
    await this.prisma.userBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetId },
    });
  }

  /// Vrai si `targetId` a bloque `userId`. C'est le sens qui compte a
  /// l'invitation : celui qui a bloque ne doit plus rien recevoir.
  async blocks(targetId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.userBlock.findUnique({
      where: { blockerId_blockedId: { blockerId: targetId, blockedId: userId } },
      select: { id: true },
    });
    return row !== null;
  }
}
