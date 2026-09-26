import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import type { CreateScenarioInput, UpdateScenarioInput } from './admin-scenario.schemas.js';

/// Ce qui tient dans une ligne de liste : de quoi reconnaitre une aventure et
/// mesurer ce qu'elle pese, sans charger un deroule de quinze pages par ligne.
export interface AdminScenarioSummary {
  id: string;
  title: string;
  description: string;
  grantOnSignup: boolean;
  npcs: number;
  clues: number;
  owners: number;
  updatedAt: string;
}

export interface AdminScenarioNpc {
  id: string;
  name: string;
  description: string;
}

export interface AdminScenarioClue {
  id: string;
  title: string;
  contentMarkdown: string;
  /// Combien de joueurs l'ont deja recu, toutes seances confondues. Retirer
  /// l'indice effacerait ces distributions : le chiffre est la pour que ce ne
  /// soit pas une surprise.
  sharedWith: number;
}

export interface AdminScenarioDetail {
  id: string;
  title: string;
  description: string;
  context: string;
  rundownMarkdown: string;
  minRecommendedPlayers: number;
  maxRecommendedPlayers: number;
  averageDurationMinutes: number;
  grantOnSignup: boolean;
  createdAt: string;
  updatedAt: string;
  npcs: AdminScenarioNpc[];
  clues: AdminScenarioClue[];
  /// Ce qu'une correction touche sans le dire : les comptes qui possedent
  /// l'aventure, les seances qui la jouent, les articles qui la vendent.
  owners: number;
  sessions: number;
  shopItems: number;
}

type ChildInput = { id?: string };

/// Le catalogue, ecrit depuis le backoffice plutot qu'a la main dans une
/// migration.
///
/// **Une modification ne redescend pas.** L'app garde le scenario telecharge
/// tel qu'elle l'a recu, et rien ici ne va la reveiller : seul un compte qui
/// telecharge apres coup verra la nouvelle version. C'est voulu — une seance
/// commencee ne doit pas voir son deroule changer sous les yeux du meneur —
/// et cela veut dire qu'une faute corrigee ce soir reste chez ceux qui ont
/// deja l'aventure.
export class AdminScenarioService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AdminScenarioSummary[]> {
    const scenarios = await this.prisma.scenario.findMany({
      orderBy: { title: 'asc' },
      include: { _count: { select: { npcs: true, clues: true, ownerships: true } } },
    });

    return scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      grantOnSignup: scenario.grantOnSignup,
      npcs: scenario._count.npcs,
      clues: scenario._count.clues,
      owners: scenario._count.ownerships,
      updatedAt: scenario.updatedAt.toISOString(),
    }));
  }

  async detail(id: string): Promise<AdminScenarioDetail> {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id },
      include: {
        npcs: { orderBy: { sortOrder: 'asc' } },
        clues: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { ownerships: true, sessions: true, shopItems: true } },
      },
    });

    if (!scenario) {
      throw notFound('Scenario introuvable');
    }

    const shared = await this.prisma.scenarioClueAccess.groupBy({
      by: ['clueId'],
      where: { clueId: { in: scenario.clues.map((clue) => clue.id) } },
      _count: { _all: true },
    });
    const sharedByClue = new Map(shared.map((row) => [row.clueId, row._count._all]));

    return {
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      context: scenario.context,
      rundownMarkdown: scenario.rundownMarkdown,
      minRecommendedPlayers: scenario.minRecommendedPlayers,
      maxRecommendedPlayers: scenario.maxRecommendedPlayers,
      averageDurationMinutes: scenario.averageDurationMinutes,
      grantOnSignup: scenario.grantOnSignup,
      createdAt: scenario.createdAt.toISOString(),
      updatedAt: scenario.updatedAt.toISOString(),
      npcs: scenario.npcs.map((npc) => ({
        id: npc.id,
        name: npc.name,
        description: npc.description,
      })),
      clues: scenario.clues.map((clue) => ({
        id: clue.id,
        title: clue.title,
        contentMarkdown: clue.contentMarkdown,
        sharedWith: sharedByClue.get(clue.id) ?? 0,
      })),
      owners: scenario._count.ownerships,
      sessions: scenario._count.sessions,
      shopItems: scenario._count.shopItems,
    };
  }

  async create(adminId: string, input: CreateScenarioInput): Promise<AdminScenarioDetail> {
    const { npcs, clues, ...fields } = input;

    const created = await this.prisma.$transaction(async (tx) => {
      const scenario = await tx.scenario.create({
        data: {
          ...fields,
          npcs: {
            create: npcs.map((npc, index) => ({
              sortOrder: index,
              name: npc.name,
              description: npc.description,
            })),
          },
          clues: {
            create: clues.map((clue, index) => ({
              sortOrder: index,
              title: clue.title,
              contentMarkdown: clue.contentMarkdown,
            })),
          },
        },
      });

      await recordAudit(tx, {
        adminId,
        action: 'scenario.create',
        targetType: 'scenario',
        targetId: scenario.id,
        details: { title: scenario.title, npcs: npcs.length, clues: clues.length },
      });

      return scenario;
    });

    return this.detail(created.id);
  }

  async update(
    id: string,
    adminId: string,
    input: UpdateScenarioInput,
    at: Date = new Date(),
  ): Promise<AdminScenarioDetail> {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id },
      include: {
        npcs: { select: { id: true } },
        clues: { select: { id: true } },
      },
    });

    if (!scenario) {
      throw notFound('Scenario introuvable');
    }

    const { npcs, clues, ...fields } = input;

    // Une fourchette se corrige d'un cote a la fois : la borne absente du
    // corps est celle deja enregistree, pas une valeur libre.
    const min = fields.minRecommendedPlayers ?? scenario.minRecommendedPlayers;
    const max = fields.maxRecommendedPlayers ?? scenario.maxRecommendedPlayers;
    if (max < min) {
      throw badRequest('Le maximum de joueurs ne peut pas etre sous le minimum');
    }

    const removedNpcs = npcs === undefined ? [] : missing(scenario.npcs, npcs);
    const removedClues = clues === undefined ? [] : missing(scenario.clues, clues);

    if (npcs !== undefined) {
      assertBelongs(npcs, scenario.npcs, 'Un personnage envoye appartient a un autre scenario');
    }
    if (clues !== undefined) {
      assertBelongs(clues, scenario.clues, 'Un indice envoye appartient a un autre scenario');
    }

    // Compte avant la suppression : la cascade aura emporte les lignes quand
    // le journal s'ecrira, et le chiffre ne serait plus trouvable nulle part.
    const revokedClueAccess =
      removedClues.length === 0
        ? 0
        : await this.prisma.scenarioClueAccess.count({ where: { clueId: { in: removedClues } } });

    await this.prisma.$transaction(async (tx) => {
      // La date est posee a la main, et c'est tout sauf un detail.
      //
      // `@updatedAt` ne bouge que si Prisma a quelque chose a ecrire : une
      // correction qui ne touche qu'un PNJ passe par un `data` vide et
      // laisserait la date intacte. Or `ScenarioNpc` et `ScenarioClue` n'ont
      // pas de date a eux — celle du scenario est **le seul signal** qu'une
      // app possede pour savoir que sa copie a vieilli. Sans cette ligne, la
      // moitie des corrections du catalogue ne reveilleraient aucun appareil.
      await tx.scenario.update({ where: { id }, data: { ...fields, updatedAt: at } });

      if (npcs !== undefined) {
        await tx.scenarioNpc.deleteMany({ where: { id: { in: removedNpcs } } });
        for (const [index, npc] of npcs.entries()) {
          const data = { sortOrder: index, name: npc.name, description: npc.description };
          if (npc.id === undefined) {
            await tx.scenarioNpc.create({ data: { ...data, scenarioId: id } });
          } else {
            await tx.scenarioNpc.update({ where: { id: npc.id }, data });
          }
        }
      }

      if (clues !== undefined) {
        await tx.scenarioClue.deleteMany({ where: { id: { in: removedClues } } });
        for (const [index, clue] of clues.entries()) {
          const data = {
            sortOrder: index,
            title: clue.title,
            contentMarkdown: clue.contentMarkdown,
          };
          if (clue.id === undefined) {
            await tx.scenarioClue.create({ data: { ...data, scenarioId: id } });
          } else {
            await tx.scenarioClue.update({ where: { id: clue.id }, data });
          }
        }
      }

      await recordAudit(tx, {
        adminId,
        action: 'scenario.update',
        targetType: 'scenario',
        targetId: id,
        details: {
          fields: Object.keys(fields),
          npcsRemoved: removedNpcs.length,
          cluesRemoved: removedClues.length,
          revokedClueAccess,
        },
      });
    });

    return this.detail(id);
  }
}

/// Les enfants enregistres qui ne sont plus dans le corps recu, donc ceux que
/// l'ecran a retires.
function missing(existing: { id: string }[], sent: ChildInput[]): string[] {
  const kept = new Set(sent.map((child) => child.id).filter((value) => value !== undefined));
  return existing.filter((child) => !kept.has(child.id)).map((child) => child.id);
}

/// Un identifiant d'un autre scenario ferait deplacer son PNJ dans celui-ci,
/// sans que rien ne le signale. Le refuser coute une ligne.
function assertBelongs(sent: ChildInput[], existing: { id: string }[], message: string): void {
  const known = new Set(existing.map((child) => child.id));
  if (sent.some((child) => child.id !== undefined && !known.has(child.id))) {
    throw badRequest(message);
  }
}
