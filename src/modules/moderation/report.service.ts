import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { EmailSender } from '../../lib/email-sender.js';
import { requireMembership } from '../tables/table.access.js';
import { renderReportEmail } from './report-email.js';
import type { CreateReportInput, ReportableContentType } from './report.schemas.js';

export interface ReportDto {
  id: string;
  contentType: string;
  contentId: string;
  createdAt: string;
}

/// Ce que le serveur a relu du contenu au moment du signalement : qui en est
/// l'auteur, et ce qu'il disait. Les libellés du relevé sont en français
/// parce qu'ils finissent tels quels sous les yeux du support.
interface ResolvedContent {
  reportedUserId: string;
  kind: string;
  snapshot: Record<string, string>;
}

/// Prisma signale la violation d'une contrainte d'unicité par ce code.
const UNIQUE_VIOLATION = 'P2002';

export class ReportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly email: EmailSender,
    private readonly logger: FastifyBaseLogger,
    private readonly options: { reportsEmailTo: string },
  ) {}

  async create(userId: string, input: CreateReportInput): Promise<ReportDto> {
    const content = await this.resolve(userId, input.contentType, input.contentId);

    if (content.reportedUserId === userId) {
      throw badRequest('On ne signale pas son propre contenu.');
    }

    const report = await this.prisma.report
      .create({
        data: {
          reporterId: userId,
          reportedUserId: content.reportedUserId,
          contentType: input.contentType,
          contentId: input.contentId,
          snapshot: JSON.stringify(content.snapshot),
          reason: input.reason,
        },
      })
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code: unknown }).code === UNIQUE_VIOLATION
        ) {
          throw conflict('Tu as déjà signalé ce contenu.');
        }
        throw error;
      });

    await this.notifySupport(userId, content, input, report.createdAt);

    return {
      id: report.id,
      contentType: report.contentType,
      contentId: report.contentId,
      createdAt: report.createdAt.toISOString(),
    };
  }

  /// Le signalement est enregistré : une panne de Resend ne doit pas le faire
  /// échouer sous les yeux de quelqu'un qui vient de subir quelque chose. La
  /// ligne en base reste, et c'est elle qui fait foi.
  private async notifySupport(
    reporterId: string,
    content: ResolvedContent,
    input: CreateReportInput,
    at: Date,
  ): Promise<void> {
    if (this.options.reportsEmailTo.length === 0) {
      return;
    }

    const [reporter, reported] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: reporterId } }),
      this.prisma.user.findUnique({ where: { id: content.reportedUserId } }),
    ]);

    try {
      await this.email.send(
        renderReportEmail({
          to: this.options.reportsEmailTo,
          kind: content.kind,
          contentType: input.contentType,
          contentId: input.contentId,
          reason: input.reason,
          snapshot: content.snapshot,
          reporterEmail: reporter?.email ?? reporterId,
          reportedEmail: reported?.email ?? content.reportedUserId,
          reportedUserId: content.reportedUserId,
          at,
        }),
      );
    } catch (error) {
      this.logger.error({ err: error }, 'failed to send report email');
    }
  }

  /// Relit le contenu visé, vérifie que l'appelant pouvait le voir, et en
  /// prend copie. Un contenu hors de portée répond 404 plutôt que 403, comme
  /// partout ici : nul ne doit pouvoir sonder quels identifiants existent.
  private async resolve(
    userId: string,
    contentType: ReportableContentType,
    contentId: string,
  ): Promise<ResolvedContent> {
    switch (contentType) {
      case 'user':
        return this.resolveUser(userId, contentId);
      case 'table':
        return this.resolveTable(userId, contentId);
      case 'session':
        return this.resolveSession(userId, contentId);
      case 'investigator':
        return this.resolveInvestigator(userId, contentId);
    }
  }

  private async resolveUser(userId: string, targetId: string): Promise<ResolvedContent> {
    // Partager une table est la seule façon de voir le pseudo de quelqu'un.
    const shared = await this.prisma.tableMember.findFirst({
      where: { userId: targetId, table: { members: { some: { userId } } } },
      select: { user: { select: { id: true, displayName: true } } },
    });

    if (!shared) {
      throw notFound('User not found');
    }

    return {
      reportedUserId: shared.user.id,
      kind: 'Un joueur',
      snapshot: { Pseudo: shared.user.displayName ?? '(sans pseudo)' },
    };
  }

  private async resolveTable(userId: string, tableId: string): Promise<ResolvedContent> {
    const table = await this.prisma.gameTable.findUnique({ where: { id: tableId } });
    if (!table) {
      throw notFound('Table not found');
    }
    await requireMembership(this.prisma, userId, tableId);

    // Une table n'a pas de description : son titre et l'univers annoncé sont
    // les deux seuls textes que son maître du jeu y écrit.
    return {
      reportedUserId: table.ownerId,
      kind: 'Une table',
      snapshot: {
        Titre: table.title,
        Univers: table.universeLabel ?? '(non précisé)',
      },
    };
  }

  private async resolveSession(userId: string, sessionId: string): Promise<ResolvedContent> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      include: { table: { select: { ownerId: true, title: true } } },
    });
    if (!session) {
      throw notFound('Session not found');
    }
    await requireMembership(this.prisma, userId, session.tableId);

    // Le lieu part avec le reste : c'est du texte libre au même titre que le
    // titre, et rien n'empêche d'y écrire autre chose qu'une adresse.
    return {
      reportedUserId: session.table.ownerId,
      kind: 'Une séance',
      snapshot: {
        Titre: session.title,
        Description: session.description ?? '(vide)',
        Lieu: session.location,
        Table: session.table.title,
      },
    };
  }

  private async resolveInvestigator(
    userId: string,
    characterId: string,
  ): Promise<ResolvedContent> {
    // On ne voit la fiche d'un autre que parce qu'il l'a assise à une séance
    // d'une table commune. Hors de là, elle n'existe pas pour l'appelant.
    const seat = await this.prisma.sessionAttendance.findFirst({
      where: {
        characterId,
        session: { table: { members: { some: { userId } } } },
      },
      select: {
        character: {
          select: {
            userId: true,
            name: true,
            occupation: true,
            description: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!seat?.character || seat.character.deletedAt) {
      throw notFound('Character not found');
    }

    return {
      reportedUserId: seat.character.userId,
      kind: 'Un investigateur',
      snapshot: {
        Nom: seat.character.name,
        Occupation: seat.character.occupation ?? '(aucune)',
        Description: seat.character.description ?? '(vide)',
      },
    };
  }
}
