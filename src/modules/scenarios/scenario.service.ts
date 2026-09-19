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

export interface ScenarioAnnexDto {
  id: string;
  sortOrder: number;
  title: string;
  kind: string;
  contentMarkdown: string;
}

export interface ScenarioDetailDto extends ScenarioSummaryDto {
  context: string;
  rundownMarkdown: string;
  annexes: ScenarioAnnexDto[];
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
      include: { annexes: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!row) {
      throw notFound('Scenario not found');
    }

    return {
      ...toSummary(row),
      context: row.context,
      rundownMarkdown: row.rundownMarkdown,
      annexes: row.annexes.map((annex) => ({
        id: annex.id,
        sortOrder: annex.sortOrder,
        title: annex.title,
        kind: annex.kind,
        contentMarkdown: annex.contentMarkdown,
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
