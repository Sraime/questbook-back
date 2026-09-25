import type { PrismaClient } from '@prisma/client';
import { notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import type { ListReportsQuery, ResolveReportInput } from './admin-report.schemas.js';

/// Qui a ecrit le contenu, ou qui l'a signale. L'adresse en fait partie : c'est
/// le seul moyen de reconnaitre quelqu'un d'un dossier a l'autre, et elle est
/// deja ce que le mail de signalement porte aujourd'hui.
export interface ReportedParty {
  id: string;
  email: string;
  displayName: string | null;
}

export interface ReportSummary {
  id: string;
  status: string;
  contentType: string;
  contentId: string;
  reason: string;
  createdAt: string;
  reportedUser: ReportedParty;
  resolution: string | null;
  resolvedAt: string | null;
}

export interface ReportDetail extends ReportSummary {
  /// Ce que le contenu disait au moment du geste. C'est la raison d'etre de la
  /// table : le contenu signale se reecrit dans la minute, et l'on examinerait
  /// sinon une version repentie plutot que celle qui a choque.
  snapshot: Record<string, string>;
  reporter: ReportedParty;
  resolutionNote: string | null;
  resolvedBy: string | null;
  /// Les autres dossiers visant le meme compte. C'est le signal le plus utile
  /// du lot : deux personnes differentes qui signalent la meme personne disent
  /// quelque chose qu'un dossier isole ne dit pas.
  otherReportsOnSameUser: ReportSummary[];
}

export interface ReportPage {
  items: ReportSummary[];
  total: number;
}

const partySelect = { id: true, email: true, displayName: true } as const;

/// Le contenu d'un instantane vient d'un `JSON.stringify` ecrit par l'API du
/// produit. Une ligne bricolee a la main ne doit pas casser l'ecran qui la
/// relit : le support verra un dossier vide, et saura qu'il y a un probleme.
const parseSnapshot = (raw: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
};

export class AdminReportService {
  constructor(private readonly prisma: PrismaClient) {}

  /// Le plus ancien en tete : la file se lit par son bout le plus urgent, et
  /// c'est celui-la qui approche des vingt-quatre heures annoncees.
  async list(query: ListReportsQuery): Promise<ReportPage> {
    const where = { status: query.status };

    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: query.offset,
        take: query.limit,
        include: { reportedUser: { select: partySelect } },
      }),
      this.prisma.report.count({ where }),
    ]);

    return { items: rows.map(toSummary), total };
  }

  async detail(id: string): Promise<ReportDetail> {
    const report = await this.prisma.report.findUnique({
      where: { id },
      include: {
        reportedUser: { select: partySelect },
        reporter: { select: partySelect },
        resolvedBy: { select: { login: true } },
      },
    });

    if (!report) {
      throw notFound('Signalement introuvable');
    }

    const others = await this.prisma.report.findMany({
      where: { reportedUserId: report.reportedUserId, id: { not: report.id } },
      orderBy: { createdAt: 'desc' },
      include: { reportedUser: { select: partySelect } },
    });

    return {
      ...toSummary(report),
      snapshot: parseSnapshot(report.snapshot),
      reporter: report.reporter,
      resolutionNote: report.resolutionNote,
      resolvedBy: report.resolvedBy?.login ?? null,
      otherReportsOnSameUser: others.map(toSummary),
    };
  }

  /// Idempotent **sans reecrire la date** : un double clic ne doit pas deplacer
  /// le moment ou le dossier a ete tranche, exactement comme `POST /auth/terms`
  /// ne deplace pas un consentement.
  async resolve(id: string, adminId: string, input: ResolveReportInput): Promise<ReportDetail> {
    const report = await this.prisma.report.findUnique({ where: { id } });
    if (!report) {
      throw notFound('Signalement introuvable');
    }

    if (report.status === 'open') {
      await this.prisma.$transaction(async (tx) => {
        await tx.report.update({
          where: { id },
          data: {
            status: 'resolved',
            resolution: input.resolution,
            resolutionNote: input.note ?? null,
            resolvedAt: new Date(),
            resolvedById: adminId,
          },
        });

        await recordAudit(tx, {
          adminId,
          action: 'report.resolve',
          targetType: 'report',
          targetId: id,
          // Le motif du signalement n'y entre pas : il est deja en base, et le
          // journal dit ce que l'administration a fait, pas ce qu'elle a lu.
          details: { resolution: input.resolution },
        });
      });
    }

    return this.detail(id);
  }
}

interface ReportRow {
  id: string;
  status: string;
  contentType: string;
  contentId: string;
  reason: string;
  createdAt: Date;
  resolution: string | null;
  resolvedAt: Date | null;
  reportedUser: ReportedParty;
}

const toSummary = (report: ReportRow): ReportSummary => ({
  id: report.id,
  status: report.status,
  contentType: report.contentType,
  contentId: report.contentId,
  reason: report.reason,
  createdAt: report.createdAt.toISOString(),
  reportedUser: report.reportedUser,
  resolution: report.resolution,
  resolvedAt: report.resolvedAt?.toISOString() ?? null,
});
