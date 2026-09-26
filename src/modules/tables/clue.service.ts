import type { PrismaClient, SessionClue } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireGameMaster, requireMembership } from './table.access.js';
import type { CreateClueInput, PatchClueInput, SetClueAccessInput } from './table.schemas.js';

/// What the game master sees: the clue, plus who he has opened it to.
export interface SessionClueDto {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  contentMarkdown: string;
  assetRef: string | null;
  /// User ids, and only those the session's table still holds.
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
}

/// What a player sees. Deliberately not a subset of the above with fields
/// blanked out: `sharedWith` must not exist at all on this side, or someone
/// will eventually send it empty instead of omitting it.
export interface PlayerClueDto {
  id: string;
  title: string;
  kind: string;
  contentMarkdown: string;
  assetRef: string | null;
  sharedAt: string;
}

type ClueRow = SessionClue & { access: { userId: string }[] };

const toDto = (row: ClueRow): SessionClueDto => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  kind: row.kind,
  contentMarkdown: row.contentMarkdown,
  assetRef: row.assetRef,
  sharedWith: row.access.map((entry) => entry.userId),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/// The inverse of [NpcService]: prepared the same way, but meant to cross the
/// screen. Everything here is game-master-only except [listForPlayer], which is
/// the one door a player knocks on.
///
/// The rule that governs the whole class: a clue belongs to nobody until the
/// game master says otherwise. An empty `sharedWith` is the resting state, not
/// an edge case.
export class ClueService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, sessionId: string): Promise<SessionClueDto[]> {
    await this.requireGameMasterOfSession(userId, sessionId);

    const rows = await this.prisma.sessionClue.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      include: { access: { select: { userId: true } } },
    });

    return rows.map(toDto);
  }

  /// Only what has been opened to them, and nothing that betrays the rest: no
  /// total, no identifier, no gap in an ordering. A player must not be able to
  /// tell how much the game master is still holding back.
  async listForPlayer(userId: string, sessionId: string): Promise<PlayerClueDto[]> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true },
    });

    if (!session) {
      throw notFound('Session not found');
    }

    await requireMembership(this.prisma, userId, session.tableId);

    const rows = await this.prisma.sessionClueAccess.findMany({
      where: { userId, clue: { sessionId } },
      orderBy: { grantedAt: 'asc' },
      include: { clue: true },
    });

    return rows.map((row) => ({
      id: row.clue.id,
      title: row.clue.title,
      kind: row.clue.kind,
      contentMarkdown: row.clue.contentMarkdown,
      assetRef: row.clue.assetRef,
      sharedAt: row.grantedAt.toISOString(),
    }));
  }

  /// Markdown only. Image clues will arrive with the scenarios that ship them,
  /// and there is nowhere for a game master to upload one anyway.
  async create(
    userId: string,
    sessionId: string,
    input: CreateClueInput,
  ): Promise<SessionClueDto> {
    await this.requireGameMasterOfSession(userId, sessionId);

    const row = await this.prisma.sessionClue.create({
      data: {
        sessionId,
        title: input.title,
        kind: 'markdown',
        contentMarkdown: input.contentMarkdown ?? '',
      },
      include: { access: { select: { userId: true } } },
    });

    return toDto(row);
  }

  async patch(
    userId: string,
    sessionId: string,
    clueId: string,
    input: PatchClueInput,
  ): Promise<SessionClueDto> {
    await this.requireGameMasterOfSession(userId, sessionId);
    const existing = await this.requireInSession(sessionId, clueId);

    // The body of an image clue is not the game master's to rewrite: it comes
    // from the scenario, and there is no editor for it.
    if (input.contentMarkdown !== undefined && existing.kind !== 'markdown') {
      throw badRequest('Only a markdown clue can have its content edited');
    }

    const row = await this.prisma.sessionClue.update({
      where: { id: clueId },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.contentMarkdown === undefined
          ? {}
          : { contentMarkdown: input.contentMarkdown }),
      },
      include: { access: { select: { userId: true } } },
    });

    return toDto(row);
  }

  async remove(userId: string, sessionId: string, clueId: string): Promise<void> {
    await this.requireGameMasterOfSession(userId, sessionId);
    await this.requireInSession(sessionId, clueId);

    await this.prisma.sessionClue.delete({ where: { id: clueId } });
  }

  /// Replaces the list rather than adding to it, because that is the gesture
  /// the screen makes: the game master ticks names and validates. Taking a clue
  /// back is then the same call with one name fewer, and needs no second route.
  async setAccess(
    userId: string,
    sessionId: string,
    clueId: string,
    input: SetClueAccessInput,
  ): Promise<SessionClueDto> {
    await this.requireGameMasterOfSession(userId, sessionId);
    await this.requireInSession(sessionId, clueId);

    const session = await this.prisma.gameSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { tableId: true },
    });

    const wanted = [...new Set(input.userIds)];

    // Naming someone who is not at the table is a mistake worth reporting, not
    // one to swallow: the caller would otherwise believe the clue is shared.
    if (wanted.length > 0) {
      const members = await this.prisma.tableMember.findMany({
        where: { tableId: session.tableId, userId: { in: wanted } },
        select: { userId: true },
      });

      if (members.length !== wanted.length) {
        throw badRequest('Every recipient must be a member of the table');
      }
    }

    // One transaction, because a half-applied sharing is worse than none: the
    // game master would read a list that does not match what the players see.
    await this.prisma.$transaction([
      this.prisma.sessionClueAccess.deleteMany({
        where: wanted.length > 0 ? { clueId, userId: { notIn: wanted } } : { clueId },
      }),
      ...wanted.map((recipient) =>
        this.prisma.sessionClueAccess.upsert({
          where: { clueId_userId: { clueId, userId: recipient } },
          update: {},
          create: { clueId, userId: recipient },
        }),
      ),
    ]);

    const row = await this.prisma.sessionClue.findUniqueOrThrow({
      where: { id: clueId },
      include: { access: { select: { userId: true } } },
    });

    return toDto(row);
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
  private async requireInSession(sessionId: string, clueId: string): Promise<SessionClue> {
    const clue = await this.prisma.sessionClue.findUnique({ where: { id: clueId } });

    if (!clue || clue.sessionId !== sessionId) {
      throw notFound('Clue not found');
    }

    return clue;
  }
}
