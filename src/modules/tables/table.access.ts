import type { Prisma, PrismaClient, User } from '@prisma/client';
import { forbidden, notFound } from '../../lib/errors.js';
import type { MemberRole } from './table.schemas.js';

/// Accepts either the pooled client or a transaction, so the guards below can
/// run inside the same transaction as the write they protect.
export type Db = PrismaClient | Prisma.TransactionClient;

export interface TableUserDto {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
}

export function toTableUserDto(user: User): TableUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    pictureUrl: user.pictureUrl,
  };
}

/// 404 rather than 403 for a table the caller is not a member of, matching the
/// character module: a caller must not be able to probe which ids exist.
export async function requireMembership(
  db: Db,
  userId: string,
  tableId: string,
): Promise<MemberRole> {
  const membership = await db.tableMember.findUnique({
    where: { tableId_userId: { tableId, userId } },
    select: { role: true },
  });

  if (!membership) {
    throw notFound('Table not found');
  }

  return membership.role as MemberRole;
}

/// Once membership is established, hiding the reason serves no purpose: the
/// player can see the table, they simply may not change it.
export async function requireGameMaster(
  db: Db,
  userId: string,
  tableId: string,
): Promise<void> {
  const role = await requireMembership(db, userId, tableId);
  if (role !== 'gm') {
    throw forbidden('Only the game master can change this table');
  }
}

export async function memberUserIds(db: Db, tableId: string): Promise<string[]> {
  const members = await db.tableMember.findMany({
    where: { tableId },
    select: { userId: true },
  });
  return members.map((member) => member.userId);
}
