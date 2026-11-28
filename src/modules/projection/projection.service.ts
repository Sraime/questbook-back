import type { PrismaClient } from '@prisma/client';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { hashToken, randomToken } from '../../lib/tokens.js';
import { requireGameMaster } from '../tables/table.access.js';
import { sessionClosesAt } from '../tables/session.window.js';

export interface ProjectionLinkDto {
  url: string;
  opensAt: string;
  closesAt: string;
}

/// La seance qu'un jeton public a le droit de montrer.
export interface ProjectedSession {
  sessionId: string;
  title: string;
  closesAt: Date;
}

/// 410 plutot que 404 pour une seance finie : l'ecran affiche alors que la
/// partie est terminee, pas que le lien est faux.
const gone = (message: string): AppError => new AppError(410, 'GONE', message);

/// Pas encore ouvert : le lien est bon, c'est l'heure qui ne l'est pas.
const notYet = (message: string): AppError => new AppError(403, 'NOT_YET_OPEN', message);

const unknownLink = () =>
  notFound("Ce lien de projection n'existe pas, ou le MJ l'a révoqué.");

/// Le mode projection : un lien public qui montre le plateau d'une seance,
/// en lecture seule, a qui le tient.
///
/// **Ce lien ne donne acces qu'a trois choses** : le plateau nettoye, la
/// liste des assets heberges, et leurs images. Aucune ecriture n'existe
/// derriere lui ; le jeton ne vaut pas une identite, et ne se presente a
/// aucune autre route.
export class ProjectionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { publicBaseUrl: string },
  ) {}

  /// Un nouveau lien, qui remplace et revoque le precedent.
  ///
  /// Toujours neuf, jamais relu : le jeton est stocke hache, comme tous les
  /// autres, et le serveur ne saurait pas le redonner. C'est l'app du MJ qui
  /// le garde pour le recopier.
  async create(userId: string, sessionId: string): Promise<ProjectionLinkDto> {
    const session = await this.requireRunnableSession(userId, sessionId);

    const token = randomToken();
    await this.prisma.gameSession.update({
      where: { id: sessionId },
      data: { projectionTokenHash: hashToken(token) },
    });

    return {
      url: `${this.options.publicBaseUrl.replace(/\/$/, '')}/projection/${token}`,
      opensAt: session.startsAt.toISOString(),
      closesAt: sessionClosesAt(session).toISOString(),
    };
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    await this.requireGameMasterOfSession(userId, sessionId);
    await this.prisma.gameSession.update({
      where: { id: sessionId },
      data: { projectionTokenHash: null },
    });
  }

  /// Si la seance a un lien en cours, sans le redonner.
  async status(userId: string, sessionId: string): Promise<{ active: boolean }> {
    const session = await this.requireGameMasterOfSession(userId, sessionId);
    return {
      active:
        session.projectionTokenHash !== null &&
        session.status !== 'cancelled' &&
        sessionClosesAt(session).getTime() > Date.now(),
    };
  }

  /// La seance d'un jeton, s'il ouvre quelque chose maintenant.
  ///
  /// La fenetre est celle de la seance, et rien d'autre : de l'heure de
  /// debut a la cloture, vingt-quatre heures plus tard. Un lien n'a donc pas
  /// de date a lui, et ne peut pas survivre a sa partie.
  async resolve(token: string, now = new Date()): Promise<ProjectedSession> {
    const session = await this.prisma.gameSession.findUnique({
      where: { projectionTokenHash: hashToken(token) },
      select: { id: true, title: true, startsAt: true, status: true },
    });

    if (!session || session.status === 'cancelled') {
      throw unknownLink();
    }

    const closesAt = sessionClosesAt(session);
    if (now.getTime() >= closesAt.getTime()) {
      throw gone('Cette séance est terminée : la projection est close.');
    }
    if (now.getTime() < session.startsAt.getTime()) {
      throw notYet(`La projection ouvrira au début de la séance, ${formatParis(session.startsAt)}.`);
    }

    return { sessionId: session.id, title: session.title, closesAt };
  }

  /// Le plateau brut ; c'est a l'appelant de le nettoyer avant de l'envoyer.
  async board(sessionId: string) {
    const row = await this.prisma.sessionBoard.findUnique({ where: { sessionId } });
    return {
      sessionId,
      tokens: row?.tokens ?? '[]',
      mapId: row?.mapId ?? null,
      revision: row?.revision ?? 0,
      updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
    };
  }

  private async requireGameMasterOfSession(userId: string, sessionId: string) {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { tableId: true, startsAt: true, status: true, projectionTokenHash: true },
    });
    if (!session) throw notFound('Session not found');

    await requireGameMaster(this.prisma, userId, session.tableId);
    return session;
  }

  private async requireRunnableSession(userId: string, sessionId: string) {
    const session = await this.requireGameMasterOfSession(userId, sessionId);
    if (session.status === 'cancelled') {
      throw conflict('Cette séance est annulée.');
    }
    if (sessionClosesAt(session).getTime() <= Date.now()) {
      throw conflict('Cette séance est terminée.');
    }
    return session;
  }
}

/// L'heure de la seance telle que la salle la lit : le serveur tourne en UTC,
/// les tables jouent en France.
function formatParis(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
