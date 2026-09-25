import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { isSuspended } from '../../modules/auth/suspension.js';
import { recordAudit } from '../audit.js';
import type { DeleteUserInput, SuspendUserInput } from './admin-user.schemas.js';

export interface AdminUserDetail {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  suspended: boolean;
  suspendedAt: string | null;
  suspendedUntil: string | null;
  suspensionReason: string | null;
  /// Ce qu'une fermeture detruirait, montre avant qu'on la demande.
  ownedTables: number;
  characters: number;
  openReports: number;
}

/// Ce qu'il faut pour juger une mesure sans ouvrir le dossier : qui, pourquoi,
/// depuis quand, et jusqu'a quand. Le compte des tables et des personnages n'y
/// est pas — il coute une jointure par ligne et ne sert qu'a la fermeture.
export interface SuspendedUserSummary {
  id: string;
  email: string;
  displayName: string | null;
  suspendedAt: string;
  suspendedUntil: string | null;
  suspensionReason: string | null;
}

export class AdminUserService {
  constructor(private readonly prisma: PrismaClient) {}

  /// Les comptes sous le coup d'une mesure encore active.
  ///
  /// Une suspension datee expire d'elle-meme, sans que rien ne la balaie :
  /// `suspendedAt` reste pose apres l'echeance. Filtrer sur sa seule presence
  /// remplirait donc la liste de comptes deja revenus, et c'est exactement ce
  /// qu'on ne veut pas montrer a quelqu'un qui cherche qui est encore dehors.
  ///
  /// L'ordre dit ce qu'il y a a faire : **les indefinies d'abord**, seules a
  /// attendre une decision humaine — personne ne les reverra jamais si cet
  /// ecran ne les montre pas — puis les datees, par echeance la plus proche.
  async listSuspended(at: Date = new Date()): Promise<SuspendedUserSummary[]> {
    const users = await this.prisma.user.findMany({
      where: {
        suspendedAt: { not: null },
        OR: [{ suspendedUntil: null }, { suspendedUntil: { gt: at } }],
      },
      orderBy: [{ suspendedUntil: { sort: 'asc', nulls: 'first' } }, { suspendedAt: 'asc' }],
      select: {
        id: true,
        email: true,
        displayName: true,
        suspendedAt: true,
        suspendedUntil: true,
        suspensionReason: true,
      },
    });

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      // Le `where` l'exclut, mais le type le laisse nullable.
      suspendedAt: user.suspendedAt!.toISOString(),
      suspendedUntil: user.suspendedUntil?.toISOString() ?? null,
      suspensionReason: user.suspensionReason,
    }));
  }

  async detail(id: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        _count: { select: { ownedTables: true, characters: true } },
      },
    });

    if (!user) {
      throw notFound('Compte introuvable');
    }

    const openReports = await this.prisma.report.count({
      where: { reportedUserId: id, status: 'open' },
    });

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt.toISOString(),
      suspended: isSuspended(user),
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
      suspendedUntil: user.suspendedUntil?.toISOString() ?? null,
      suspensionReason: user.suspensionReason,
      ownedTables: user._count.ownedTables,
      characters: user._count.characters,
      openReports,
    };
  }

  /// Suspendre plutot que supprimer.
  ///
  /// Fermer est irreversible et emporte les tables que le compte animait : la
  /// bonne reponse a quelqu'un qui n'a rien a faire la, une reponse
  /// disproportionnee a un titre de seance grossier.
  async suspend(
    id: string,
    adminId: string,
    input: SuspendUserInput,
    at: Date = new Date(),
  ): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw notFound('Compte introuvable');
    }

    const until = input.until === undefined ? null : new Date(input.until);
    if (until !== null && until <= at) {
      throw badRequest('Une suspension qui expire dans le passe ne suspend rien.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { suspendedAt: at, suspendedUntil: until, suspensionReason: input.reason },
      });

      // Les jetons de rafraichissement partent avec : sans cela, la session en
      // cours vivrait ses trente jours. Le controle a la connexion et au
      // rafraichissement reste necessaire, pour le jeton emis entre-temps.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: at },
      });

      await recordAudit(tx, {
        adminId,
        action: 'user.suspend',
        targetType: 'user',
        targetId: id,
        details: { until: until?.toISOString() ?? null },
      });
    });

    return this.detail(id);
  }

  async lift(id: string, adminId: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw notFound('Compte introuvable');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { suspendedAt: null, suspendedUntil: null, suspensionReason: null },
      });

      await recordAudit(tx, {
        adminId,
        action: 'user.unsuspend',
        targetType: 'user',
        targetId: id,
      });
    });

    return this.detail(id);
  }

  /// Le meme `user.delete` que `DELETE /auth/me`, et les memes cascades — y
  /// compris les tables que le compte animait, `GameTable.ownerId` etant en
  /// cascade et une table sans MJ etant une salle morte.
  ///
  /// C'est le seul endroit du produit ou un tiers detruit les donnees de
  /// quelqu'un. La ligne d'audit est ecrite **avant** la suppression, et hors
  /// de sa transaction : `admin_audit_log` ne pointe pas vers `users`, mais
  /// une trace qui disparaitrait avec ce qu'elle trace ne vaudrait rien.
  async remove(id: string, adminId: string, input: DeleteUserInput): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { ownedTables: true } } },
    });

    if (!user) {
      throw notFound('Compte introuvable');
    }

    if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw badRequest("L'adresse de confirmation ne correspond pas a ce compte.");
    }

    await recordAudit(this.prisma, {
      adminId,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      details: { email: user.email, ownedTables: user._count.ownedTables },
    });

    await this.prisma.user.delete({ where: { id } });
  }
}
