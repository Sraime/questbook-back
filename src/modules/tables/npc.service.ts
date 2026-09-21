import type { PrismaClient, SessionNpc } from '@prisma/client';
import { notFound } from '../../lib/errors.js';
import { requireGameMaster } from './table.access.js';
import type { CreateNpcInput, PatchNpcInput } from './table.schemas.js';

export interface SessionNpcDto {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

const toDto = (row: SessionNpc): SessionNpcDto => ({
  id: row.id,
  sessionId: row.sessionId,
  name: row.name,
  description: row.description,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/// Everyone at the table who is not a player: creature, informant, ghost.
///
/// Every route here is game-master-only, reads included. That is the whole
/// point of the feature: what the game master has written down is exactly what
/// the players are not supposed to know, so there is no player-facing view to
/// design and none to forget.
export class NpcService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, sessionId: string): Promise<SessionNpcDto[]> {
    await this.requireGameMasterOfSession(userId, sessionId);

    const rows = await this.prisma.sessionNpc.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toDto);
  }

  async create(
    userId: string,
    sessionId: string,
    input: CreateNpcInput,
  ): Promise<SessionNpcDto> {
    await this.requireGameMasterOfSession(userId, sessionId);

    const row = await this.prisma.sessionNpc.create({
      data: {
        sessionId,
        name: input.name,
        description: input.description ?? '',
      },
    });

    return toDto(row);
  }

  async patch(
    userId: string,
    sessionId: string,
    npcId: string,
    input: PatchNpcInput,
  ): Promise<SessionNpcDto> {
    await this.requireGameMasterOfSession(userId, sessionId);
    await this.requireInSession(sessionId, npcId);

    const row = await this.prisma.sessionNpc.update({
      where: { id: npcId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });

    return toDto(row);
  }

  async remove(userId: string, sessionId: string, npcId: string): Promise<void> {
    await this.requireGameMasterOfSession(userId, sessionId);
    await this.requireInSession(sessionId, npcId);

    await this.prisma.sessionNpc.delete({ where: { id: npcId } });
  }

  /// 404 rather than 403 for a session the caller cannot see, like everywhere
  /// else: a caller must not be able to probe which ids exist.
  private async requireGameMasterOfSession(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true },
    });

    if (!session) {
      throw notFound('Session not found');
    }

    await requireGameMaster(this.prisma, userId, session.tableId);
  }

  /// The id is in the URL under its session, so it must actually belong to it:
  /// otherwise a game master could reach into another evening of another table
  /// through a session they do run.
  private async requireInSession(sessionId: string, npcId: string): Promise<void> {
    const npc = await this.prisma.sessionNpc.findUnique({
      where: { id: npcId },
      select: { sessionId: true },
    });

    if (!npc || npc.sessionId !== sessionId) {
      throw notFound('Non-player character not found');
    }
  }
}
