import type { PrismaClient } from '@prisma/client';
import { notFound } from '../../lib/errors.js';

export interface ScenarioSummaryDto {
  id: string;
  title: string;
  description: string;
  minRecommendedPlayers: number;
  maxRecommendedPlayers: number;
  averageDurationMinutes: number;
}

export interface ScenarioNpcDto {
  id: string;
  sortOrder: number;
  name: string;
  description: string;
}

/// What the adventure means to be handed over. Was an annex, and was only ever
/// read in the scenario's own screen; it is now the same thing a game master
/// shares during the evening, so it bears the product's word for it.
export interface ScenarioClueDto {
  id: string;
  sortOrder: number;
  title: string;
  contentMarkdown: string;
}

/// Everything at once, because the app stores this document whole to read it
/// offline: a second call for the cast would be a second chance to be missing
/// the evening it matters.
export interface ScenarioDetailDto extends ScenarioSummaryDto {
  context: string;
  rundownMarkdown: string;
  npcs: ScenarioNpcDto[];
  clues: ScenarioClueDto[];
}

const summarySelect = {
  id: true,
  title: true,
  description: true,
  minRecommendedPlayers: true,
  maxRecommendedPlayers: true,
  averageDurationMinutes: true,
} as const;

function toSummary(row: {
  id: string;
  title: string;
  description: string;
  minRecommendedPlayers: number;
  maxRecommendedPlayers: number;
  averageDurationMinutes: number;
}): ScenarioSummaryDto {
  return { ...row };
}

/// Gives every signed-in account the starter catalogue. Idempotent: already
/// owned rows are skipped. The shop will stop using `grantOnSignup`.
export async function grantStarterScenarios(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  const starters = await prisma.scenario.findMany({
    where: { grantOnSignup: true },
    select: { id: true },
  });

  if (starters.length === 0) return;

  await prisma.scenarioOwnership.createMany({
    data: starters.map((scenario) => ({
      userId,
      scenarioId: scenario.id,
      source: 'grant',
    })),
    skipDuplicates: true,
  });
}

export class ScenarioService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<ScenarioSummaryDto[]> {
    await grantStarterScenarios(this.prisma, userId);

    const rows = await this.prisma.scenario.findMany({
      where: { ownerships: { some: { userId } } },
      select: summarySelect,
      orderBy: { title: 'asc' },
    });

    return rows.map(toSummary);
  }

  /// Full document for an owned scenario. Unknown or unowned ids are the
  /// same 404: the catalogue is not public.
  async get(userId: string, scenarioId: string): Promise<ScenarioDetailDto> {
    await grantStarterScenarios(this.prisma, userId);

    const owned = await this.prisma.scenarioOwnership.findUnique({
      where: { userId_scenarioId: { userId, scenarioId } },
    });

    if (!owned) {
      throw notFound('Scenario not found');
    }

    const row = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      include: {
        npcs: { orderBy: { sortOrder: 'asc' } },
        clues: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!row) {
      throw notFound('Scenario not found');
    }

    return {
      ...toSummary(row),
      context: row.context,
      rundownMarkdown: row.rundownMarkdown,
      npcs: row.npcs.map((npc) => ({
        id: npc.id,
        sortOrder: npc.sortOrder,
        name: npc.name,
        description: npc.description,
      })),
      clues: row.clues.map((clue) => ({
        id: clue.id,
        sortOrder: clue.sortOrder,
        title: clue.title,
        contentMarkdown: clue.contentMarkdown,
      })),
    };
  }

  async requireOwned(userId: string, scenarioId: string): Promise<void> {
    await grantStarterScenarios(this.prisma, userId);

    const owned = await this.prisma.scenarioOwnership.findUnique({
      where: { userId_scenarioId: { userId, scenarioId } },
    });

    if (!owned) {
      throw notFound('Scenario not found');
    }
  }
}
