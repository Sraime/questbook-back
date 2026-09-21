import type { PrismaClient, SessionBoard } from '@prisma/client';
import { notFound } from '../../lib/errors.js';
import { requireGameMaster, requireMembership } from './table.access.js';
import type { ReplaceBoardInput } from './table.schemas.js';

export interface SessionBoardDto {
  sessionId: string;
  /// The same opaque JSON the app stores locally. The server does not read
  /// what a pawn is: it would have to learn the shape of every future one,
  /// and a board it failed to parse is a board nobody can see.
  tokens: string;
  mapId: string | null;
  revision: number;
  updatedAt: string;
}

const toDto = (row: SessionBoard): SessionBoardDto => ({
  sessionId: row.sessionId,
  tokens: row.tokens,
  mapId: row.mapId,
  revision: row.revision,
  updatedAt: row.updatedAt.toISOString(),
});

/// What everyone at the table looks at while the game master runs the
/// evening.
///
/// The asymmetry is the whole design: **every member reads, only the game
/// master writes.** Unlike the non-player characters next door, whose reads
/// are game-master-only — a board is meant to be seen, a prepared creature is
/// meant not to be.
export class BoardService {
  constructor(private readonly prisma: PrismaClient) {}

  /// An empty board rather than a 404 when nothing has been pushed yet: the
  /// session exists and a player may open it before the game master has
  /// placed anything. Telling them "not found" would look like a failure
  /// where there is simply nothing yet.
  async get(userId: string, sessionId: string): Promise<SessionBoardDto> {
    await this.requireMemberOfSession(userId, sessionId);

    const row = await this.prisma.sessionBoard.findUnique({
      where: { sessionId },
    });

    if (!row) {
      return {
        sessionId,
        tokens: '[]',
        mapId: null,
        revision: 0,
        updatedAt: new Date(0).toISOString(),
      };
    }

    return toDto(row);
  }

  /// Replaces the whole board, and does not merge.
  ///
  /// Only one account ever writes here, so the last push wins and there is
  /// nothing to reconcile. A partial update would be worse than useless: the
  /// device already holds the complete truth, and sending a diff would let
  /// the two drift apart the first time a message went missing.
  async replace(
    userId: string,
    sessionId: string,
    input: ReplaceBoardInput,
  ): Promise<SessionBoardDto> {
    await this.requireGameMasterOfSession(userId, sessionId);

    const row = await this.prisma.sessionBoard.upsert({
      where: { sessionId },
      create: {
        sessionId,
        tokens: input.tokens,
        mapId: input.mapId ?? null,
        revision: 1,
      },
      update: {
        tokens: input.tokens,
        mapId: input.mapId ?? null,
        revision: { increment: 1 },
      },
    });

    return toDto(row);
  }

  /// Which table an account must belong to in order to see this board — and
  /// whether the account is its game master. Read once here so the WebSocket
  /// handshake can authorise a listener without repeating the query.
  async membership(
    userId: string,
    sessionId: string,
  ): Promise<{ tableId: string; isGameMaster: boolean }> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true },
    });

    if (!session) {
      throw notFound('Session not found');
    }

    const role = await requireMembership(this.prisma, userId, session.tableId);
    return { tableId: session.tableId, isGameMaster: role === 'gm' };
  }

  /// 404 rather than 403 for a session the caller cannot see, like everywhere
  /// else: a caller must not be able to probe which ids exist.
  private async requireMemberOfSession(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    await this.membership(userId, sessionId);
  }

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
}
