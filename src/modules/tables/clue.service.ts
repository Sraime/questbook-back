import type { PrismaClient, ScenarioClue, SessionClue } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireGameMaster, requireMembership } from './table.access.js';
import type { CreateClueInput, PatchClueInput, SetClueAccessInput } from './table.schemas.js';

/// Where a clue comes from, and therefore what may be done to it. A `scenario`
/// one is read from the catalogue the session declares: the game master hands
/// it out, but it is the author's, not his to rewrite or to destroy.
export type ClueOrigin = 'gameMaster' | 'scenario';

/// What the game master sees: the clue, plus who he has opened it to.
export interface SessionClueDto {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  contentMarkdown: string;
  assetRef: string | null;
  origin: ClueOrigin;
  /// User ids, and only those the session's table still holds.
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
}

/// What a player sees. Deliberately not a subset of the above with fields
/// blanked out: `sharedWith` must not exist at all on this side, or someone
/// will eventually send it empty instead of omitting it.
///
/// No origin either, and for the same kind of reason: which of the two the
/// game master wrote himself is none of a player's business.
export interface PlayerClueDto {
  id: string;
  title: string;
  kind: string;
  contentMarkdown: string;
  assetRef: string | null;
  sharedAt: string;
}

type ClueRow = SessionClue & { access: { userId: string }[] };
type ScenarioClueRow = ScenarioClue & { access: { userId: string }[] };

const toDto = (row: ClueRow): SessionClueDto => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  kind: row.kind,
  contentMarkdown: row.contentMarkdown,
  assetRef: row.assetRef,
  origin: 'gameMaster',
  sharedWith: row.access.map((entry) => entry.userId),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/// The catalogue's rows carry no dates of their own: what a reader would want
/// from one is when the adventure last changed, which is the scenario's.
const fromScenario = (
  row: ScenarioClueRow,
  sessionId: string,
  scenarioUpdatedAt: Date,
): SessionClueDto => ({
  id: row.id,
  sessionId,
  title: row.title,
  kind: 'markdown',
  contentMarkdown: row.contentMarkdown,
  assetRef: null,
  origin: 'scenario',
  sharedWith: row.access.map((entry) => entry.userId),
  createdAt: scenarioUpdatedAt.toISOString(),
  updatedAt: scenarioUpdatedAt.toISOString(),
});

/// The inverse of [NpcService]: prepared the same way, but meant to cross the
/// screen. Everything here is game-master-only except [listForPlayer], which is
/// the one door a player knocks on.
///
/// The rule that governs the whole class: a clue belongs to nobody until the
/// game master says otherwise. An empty `sharedWith` is the resting state, not
/// an edge case.
///
/// A session plays with two piles at once — what the scenario ships and what
/// the game master wrote — and the difference shows in one place only: who may
/// rewrite them. Sharing works the same on both, which is the whole point of
/// putting the catalogue's clues in his hands.
export class ClueService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, sessionId: string): Promise<SessionClueDto[]> {
    const session = await this.requireGameMasterOfSession(userId, sessionId);

    const [scenario, rows] = await Promise.all([
      this.scenarioClues(session.scenarioId, sessionId),
      this.prisma.sessionClue.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'asc' },
        include: { access: { select: { userId: true } } },
      }),
    ]);

    return [
      ...scenario.clues.map((clue) => fromScenario(clue, sessionId, scenario.updatedAt)),
      ...rows.map(toDto),
    ];
  }

  /// Only what has been opened to them, and nothing that betrays the rest: no
  /// total, no identifier, no gap in an ordering. A player must not be able to
  /// tell how much the game master is still holding back.
  async listForPlayer(userId: string, sessionId: string): Promise<PlayerClueDto[]> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true, scenarioId: true },
    });

    if (!session) {
      throw notFound('Session not found');
    }

    await requireMembership(this.prisma, userId, session.tableId);

    // Scoped to the scenario the session declares *today*: detaching one takes
    // its clues back, and a permission left behind must not outlive it.
    const [own, fromCatalogue] = await Promise.all([
      this.prisma.sessionClueAccess.findMany({
        where: { userId, clue: { sessionId } },
        orderBy: { grantedAt: 'asc' },
        include: { clue: true },
      }),
      session.scenarioId
        ? this.prisma.scenarioClueAccess.findMany({
            where: { userId, sessionId, clue: { scenarioId: session.scenarioId } },
            orderBy: { grantedAt: 'asc' },
            include: { clue: true },
          })
        : [],
    ]);

    const clues: PlayerClueDto[] = [
      ...own.map((row) => ({
        id: row.clue.id,
        title: row.clue.title,
        kind: row.clue.kind,
        contentMarkdown: row.clue.contentMarkdown,
        assetRef: row.clue.assetRef,
        sharedAt: row.grantedAt.toISOString(),
      })),
      ...fromCatalogue.map((row) => ({
        id: row.clue.id,
        title: row.clue.title,
        kind: 'markdown',
        contentMarkdown: row.clue.contentMarkdown,
        assetRef: null,
        sharedAt: row.grantedAt.toISOString(),
      })),
    ];

    // In the order they were received, the two piles merged: a player has no
    // reason to see where each one came from.
    return clues.sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
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
    const session = await this.requireGameMasterOfSession(userId, sessionId);
    const existing = await this.requireOwnClue(session, sessionId, clueId);

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
    const session = await this.requireGameMasterOfSession(userId, sessionId);
    await this.requireOwnClue(session, sessionId, clueId);

    await this.prisma.sessionClue.delete({ where: { id: clueId } });
  }

  /// Replaces the list rather than adding to it, because that is the gesture
  /// the screen makes: the game master ticks names and validates. Taking a clue
  /// back is then the same call with one name fewer, and needs no second route.
  ///
  /// Works on both piles: handing out what the adventure ships is the reason it
  /// ships it.
  async setAccess(
    userId: string,
    sessionId: string,
    clueId: string,
    input: SetClueAccessInput,
  ): Promise<SessionClueDto> {
    const session = await this.requireGameMasterOfSession(userId, sessionId);

    const wanted = [...new Set(input.userIds)];
    await this.requireEveryRecipientAtTable(session.tableId, wanted);

    const fromCatalogue = await this.scenarioClueOfSession(session, clueId);

    if (fromCatalogue) {
      return this.setScenarioAccess(sessionId, fromCatalogue, wanted, session.scenarioUpdatedAt);
    }

    await this.requireOwnClue(session, sessionId, clueId);

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

  /// The same gesture on the catalogue's side, where the session is part of the
  /// key: the same clue is handed out evening after evening, elsewhere, to
  /// other people, and none of that must leak from one table to the next.
  private async setScenarioAccess(
    sessionId: string,
    clue: ScenarioClue,
    wanted: string[],
    scenarioUpdatedAt: Date,
  ): Promise<SessionClueDto> {
    const clueId = clue.id;

    await this.prisma.$transaction([
      this.prisma.scenarioClueAccess.deleteMany({
        where:
          wanted.length > 0
            ? { sessionId, clueId, userId: { notIn: wanted } }
            : { sessionId, clueId },
      }),
      ...wanted.map((recipient) =>
        this.prisma.scenarioClueAccess.upsert({
          where: {
            sessionId_clueId_userId: { sessionId, clueId, userId: recipient },
          },
          update: {},
          create: { sessionId, clueId, userId: recipient },
        }),
      ),
    ]);

    const access = await this.prisma.scenarioClueAccess.findMany({
      where: { sessionId, clueId },
      select: { userId: true },
    });

    return fromScenario({ ...clue, access }, sessionId, scenarioUpdatedAt);
  }

  /// Naming someone who is not at the table is a mistake worth reporting, not
  /// one to swallow: the caller would otherwise believe the clue is shared.
  private async requireEveryRecipientAtTable(
    tableId: string,
    wanted: string[],
  ): Promise<void> {
    if (wanted.length === 0) return;

    const members = await this.prisma.tableMember.findMany({
      where: { tableId, userId: { in: wanted } },
      select: { userId: true },
    });

    if (members.length !== wanted.length) {
      throw badRequest('Every recipient must be a member of the table');
    }
  }

  /// 404 rather than 403 for a session the caller cannot see, like everywhere
  /// else: a caller must not be able to probe which ids exist.
  private async requireGameMasterOfSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionContext> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true, scenarioId: true, scenario: { select: { updatedAt: true } } },
    });

    if (!session) {
      throw notFound('Session not found');
    }

    await requireGameMaster(this.prisma, userId, session.tableId);

    return {
      tableId: session.tableId,
      scenarioId: session.scenarioId,
      scenarioUpdatedAt: session.scenario?.updatedAt ?? new Date(0),
    };
  }

  private async scenarioClues(
    scenarioId: string | null,
    sessionId: string,
  ): Promise<{ clues: ScenarioClueRow[]; updatedAt: Date }> {
    if (!scenarioId) return { clues: [], updatedAt: new Date(0) };

    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      select: {
        updatedAt: true,
        clues: {
          orderBy: { sortOrder: 'asc' },
          include: {
            access: { where: { sessionId }, select: { userId: true } },
          },
        },
      },
    });

    if (!scenario) return { clues: [], updatedAt: new Date(0) };

    return { clues: scenario.clues, updatedAt: scenario.updatedAt };
  }

  private async scenarioClueOfSession(
    session: SessionContext,
    clueId: string,
  ): Promise<ScenarioClue | null> {
    if (!session.scenarioId) return null;

    const clue = await this.prisma.scenarioClue.findUnique({ where: { id: clueId } });

    return clue && clue.scenarioId === session.scenarioId ? clue : null;
  }

  /// The id is in the URL under its session, so it must actually belong to it:
  /// otherwise a game master could reach into another evening of another table
  /// through a session they do run.
  ///
  /// A clue read from the scenario is a case of its own: it exists, the game
  /// master is looking straight at it, and answering «not found» would send him
  /// hunting for a bug. It is simply not his to rewrite.
  private async requireOwnClue(
    session: SessionContext,
    sessionId: string,
    clueId: string,
  ): Promise<SessionClue> {
    const clue = await this.prisma.sessionClue.findUnique({ where: { id: clueId } });

    if (clue && clue.sessionId === sessionId) return clue;

    if (await this.scenarioClueOfSession(session, clueId)) {
      throw badRequest("A scenario's clue cannot be edited or removed");
    }

    throw notFound('Clue not found');
  }
}

interface SessionContext {
  tableId: string;
  scenarioId: string | null;
  /// Falls back to the epoch when the session plays no scenario: nothing is
  /// read from the catalogue then, so no date is ever shown.
  scenarioUpdatedAt: Date;
}
