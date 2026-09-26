import type { PrismaClient, ScenarioNpc, SessionNpc } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireGameMaster } from './table.access.js';
import type { CreateNpcInput, PatchNpcInput } from './table.schemas.js';

/// Where a non-player character comes from, and therefore what may be done to
/// it. A `scenario` one is read from the catalogue the session declares: the
/// game master plays it, but it is the author's, not his.
export type NpcOrigin = 'gameMaster' | 'scenario';

export interface SessionNpcDto {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  origin: NpcOrigin;
  createdAt: string;
  updatedAt: string;
}

const toDto = (row: SessionNpc): SessionNpcDto => ({
  id: row.id,
  sessionId: row.sessionId,
  name: row.name,
  description: row.description,
  origin: 'gameMaster',
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/// The catalogue's rows carry no dates of their own: what a reader would want
/// from one is when the adventure last changed, which is the scenario's.
const fromScenario = (
  row: ScenarioNpc,
  sessionId: string,
  scenarioUpdatedAt: Date,
): SessionNpcDto => ({
  id: row.id,
  sessionId,
  name: row.name,
  description: row.description,
  origin: 'scenario',
  createdAt: scenarioUpdatedAt.toISOString(),
  updatedAt: scenarioUpdatedAt.toISOString(),
});

/// Everyone at the table who is not a player: creature, informant, ghost.
///
/// Every route here is game-master-only, reads included. That is the whole
/// point of the feature: what the game master has written down is exactly what
/// the players are not supposed to know, so there is no player-facing view to
/// design and none to forget.
export class NpcService {
  constructor(private readonly prisma: PrismaClient) {}

  /// The scenario's cast first, then what the game master added, and nothing
  /// is copied on the way: the catalogue is read live, so a correction to an
  /// adventure reaches the evening it is played.
  async list(userId: string, sessionId: string): Promise<SessionNpcDto[]> {
    const session = await this.requireGameMasterOfSession(userId, sessionId);

    const [scenario, rows] = await Promise.all([
      this.scenarioNpcs(session.scenarioId),
      this.prisma.sessionNpc.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return [
      ...scenario.npcs.map((npc) => fromScenario(npc, sessionId, scenario.updatedAt)),
      ...rows.map(toDto),
    ];
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
  ): Promise<{ scenarioId: string | null }> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true, scenarioId: true },
    });

    if (!session) {
      throw notFound('Session not found');
    }

    await requireGameMaster(this.prisma, userId, session.tableId);

    return { scenarioId: session.scenarioId };
  }

  private async scenarioNpcs(
    scenarioId: string | null,
  ): Promise<{ npcs: ScenarioNpc[]; updatedAt: Date }> {
    if (!scenarioId) return { npcs: [], updatedAt: new Date(0) };

    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      select: {
        updatedAt: true,
        npcs: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!scenario) return { npcs: [], updatedAt: new Date(0) };

    return { npcs: scenario.npcs, updatedAt: scenario.updatedAt };
  }

  /// The id is in the URL under its session, so it must actually belong to it:
  /// otherwise a game master could reach into another evening of another table
  /// through a session they do run.
  ///
  /// A character read from the scenario is a case of its own: it exists, the
  /// game master is looking straight at it, and answering «not found» would
  /// send him hunting for a bug. It is simply not his to rewrite.
  private async requireInSession(sessionId: string, npcId: string): Promise<void> {
    const npc = await this.prisma.sessionNpc.findUnique({
      where: { id: npcId },
      select: { sessionId: true },
    });

    if (npc && npc.sessionId === sessionId) return;

    const fromCatalogue = await this.prisma.scenarioNpc.findUnique({
      where: { id: npcId },
      select: { id: true },
    });

    if (fromCatalogue) {
      throw badRequest("A scenario's non-player character cannot be edited or removed");
    }

    throw notFound('Non-player character not found');
  }
}
