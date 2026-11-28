import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../../lib/errors.js';
import { hashToken, randomToken } from '../../lib/tokens.js';
import type { EmailSender } from '../../lib/email-sender.js';
import type {
  NotificationDraft,
  NotificationService,
} from '../notifications/notification.service.js';
import {
  memberUserIds,
  publicLabel,
  requireGameMaster,
  requireMembership,
  toTableUserDto,
  type TableUserDto,
} from './table.access.js';
import { renderInvitationEmail } from './invitation-email.js';
import { sessionGraceMs } from './session.window.js';
import type {
  CreateTableInput,
  InviteInput,
  MemberRole,
  PatchTableInput,
} from './table.schemas.js';

export interface TableMemberDto {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  user: TableUserDto;
}

export interface TableInvitationDto {
  id: string;
  tableId: string;
  tableTitle: string;
  email: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  invitedBy: TableUserDto;
}

export interface GameTableDto {
  id: string;
  title: string;
  universeLabel: string | null;
  ownerId: string;
  /// The caller's own role, so the client can hide game-master controls
  /// without re-deriving it from the member list.
  role: MemberRole;
  createdAt: string;
  updatedAt: string;
  members: TableMemberDto[];
  pendingInvitations: TableInvitationDto[];
  nextSessionAt: string | null;
}

/// A function rather than a constant: the session cutoff below is "now", and a
/// module-level object would freeze it at import time — a long-running server
/// would keep answering with the date it booted on.
function tableInclude() {
  return {
    members: {
      include: { user: true },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    },
    invitations: {
      where: { status: 'pending' },
      include: { invitedBy: true },
      orderBy: { createdAt: 'asc' },
    },
    /// Nothing moves a session to another status once it has happened, so
    /// without the cutoff the earliest `scheduled` row wins forever — and a
    /// past session ends up hiding the one players are waiting for.
    ///
    /// Le seuil recule de la durée de grâce : une séance commencée est encore
    /// celle qui occupe la table, et l'annoncer passée en pleine partie serait
    /// mentir à tout le monde.
    sessions: {
      where: {
        status: 'scheduled',
        startsAt: { gt: new Date(Date.now() - sessionGraceMs) },
      },
      orderBy: { startsAt: 'asc' },
      take: 1,
    },
  } satisfies Prisma.GameTableInclude;
}

type TableWithRelations = Prisma.GameTableGetPayload<{
  include: ReturnType<typeof tableInclude>;
}>;

function displayNameOf(user: TableUserDto): string {
  return user.displayName;
}

/// Players around the table, not counting the game master. Pending invitations
/// occupy a seat so a GM cannot flood a table that is already full.
const MAX_PLAYERS_PER_TABLE = 8;

/// Per GM account, across every table, to stop a stolen session from spamming
/// arbitrary mailboxes.
const MAX_INVITES_PER_DAY = 15;

export class TableService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly email: EmailSender,
    private readonly options: { publicBaseUrl: string; invitationTtlDays: number },
  ) {}

  // --- Tables ---

  async list(userId: string): Promise<GameTableDto[]> {
    const rows = await this.prisma.gameTable.findMany({
      where: { members: { some: { userId } } },
      include: tableInclude(),
      orderBy: { updatedAt: 'desc' },
    });

    return rows.map((row) => this.toDto(row, userId));
  }

  async get(userId: string, tableId: string): Promise<GameTableDto> {
    await requireMembership(this.prisma, userId, tableId);

    const row = await this.prisma.gameTable.findUnique({
      where: { id: tableId },
      include: tableInclude(),
    });

    if (!row) {
      throw notFound('Table not found');
    }

    return this.toDto(row, userId);
  }

  /// Creating a table also enrols the creator as its game master, so every
  /// later authorisation check is a plain membership lookup.
  async create(userId: string, input: CreateTableInput): Promise<GameTableDto> {
    const row = await this.prisma.gameTable.create({
      data: {
        title: input.title,
        universeLabel: input.universeLabel ?? null,
        ownerId: userId,
        members: { create: { userId, role: 'gm' } },
      },
      include: tableInclude(),
    });

    return this.toDto(row, userId);
  }

  async patch(
    userId: string,
    tableId: string,
    input: PatchTableInput,
  ): Promise<GameTableDto> {
    await requireGameMaster(this.prisma, userId, tableId);

    const row = await this.prisma.gameTable.update({
      where: { id: tableId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.universeLabel !== undefined
          ? { universeLabel: input.universeLabel ?? null }
          : {}),
      },
      include: tableInclude(),
    });

    return this.toDto(row, userId);
  }

  async remove(userId: string, tableId: string): Promise<void> {
    await requireGameMaster(this.prisma, userId, tableId);
    await this.prisma.gameTable.delete({ where: { id: tableId } });
  }

  // --- Members ---

  /// A game master cannot walk away from their own table: with no one able to
  /// schedule anything it would be a dead room. They delete it instead.
  async leave(userId: string, tableId: string): Promise<void> {
    const role = await requireMembership(this.prisma, userId, tableId);
    if (role === 'gm') {
      throw forbidden('The game master cannot leave their own table; delete it instead');
    }

    await this.dropMembership(tableId, userId);
  }

  /// Handing over the table. The two roles are swapped rather than duplicated:
  /// a table has exactly one game master, and the outgoing one stays as a
  /// player.
  ///
  /// Past sessions are left exactly as they were. The new game master may well
  /// have played one with a character, and that happened. Only sessions still
  /// ahead of us lose their attendance, because from now on they will be
  /// running those rather than playing them.
  async transferGameMaster(
    userId: string,
    tableId: string,
    memberUserId: string,
  ): Promise<GameTableDto> {
    await requireGameMaster(this.prisma, userId, tableId);

    if (memberUserId === userId) {
      throw badRequest('You are already the game master of this table');
    }

    const successor = await this.prisma.tableMember.findUnique({
      where: { tableId_userId: { tableId, userId: memberUserId } },
      include: { user: true },
    });

    if (!successor) {
      throw notFound('Member not found');
    }

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: tableId },
      select: { title: true },
    });

    const outgoing = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const drafts: NotificationDraft[] = [
      {
        userId: memberUserId,
        type: 'game_master_transferred',
        title: `Tu es MJ · ${table.title}`,
        body:
          `${displayNameOf(toTableUserDto(outgoing))} te confie la table. ` +
          'À toi d’organiser les sessions.',
        tableId,
      },
    ];

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.tableMember.update({
        where: { tableId_userId: { tableId, userId } },
        data: { role: 'player' },
      });

      await tx.tableMember.update({
        where: { tableId_userId: { tableId, userId: memberUserId } },
        data: { role: 'gm' },
      });

      // `ownerId` is denormalised from the member roles and is what the
      // notification code reads to find the game master, so the two must move
      // together.
      const updated = await tx.gameTable.update({
        where: { id: tableId },
        data: { ownerId: memberUserId },
        include: tableInclude(),
      });

      await tx.sessionAttendance.deleteMany({
        where: {
          userId: memberUserId,
          session: { tableId, startsAt: { gt: new Date() } },
        },
      });

      await this.notifications.record(tx, drafts);
      return updated;
    });

    this.notifications.deliver(drafts);

    return this.toDto(row, userId);
  }

  async removeMember(
    userId: string,
    tableId: string,
    memberUserId: string,
  ): Promise<void> {
    await requireGameMaster(this.prisma, userId, tableId);

    if (memberUserId === userId) {
      throw badRequest('Use DELETE on the table itself to disband it');
    }

    const membership = await this.prisma.tableMember.findUnique({
      where: { tableId_userId: { tableId, userId: memberUserId } },
      select: { id: true },
    });

    if (!membership) {
      throw notFound('Member not found');
    }

    await this.dropMembership(tableId, memberUserId);
  }

  /// Leaving and being removed are the same departure, and both must take the
  /// clues along. Their permissions hang off the account, not off membership:
  /// nothing in the schema would drop them, and coming back to the table would
  /// silently hand back everything the game master had once opened.
  private async dropMembership(tableId: string, userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.sessionClueAccess.deleteMany({
        where: { userId, clue: { session: { tableId } } },
      }),
      this.prisma.tableMember.delete({
        where: { tableId_userId: { tableId, userId } },
      }),
    ]);
  }

  // --- Invitations ---

  /// The mailed link carries a single-use code that any signed-in account can
  /// redeem, whatever its own address. When the address already has an
  /// account, that account is also notified and finds the invitation in the
  /// app.
  async invite(
    userId: string,
    tableId: string,
    input: InviteInput,
  ): Promise<TableInvitationDto> {
    await requireGameMaster(this.prisma, userId, tableId);

    const email = input.email.trim().toLowerCase();
    const invited = await this.prisma.user.findUnique({ where: { email } });

    if (invited?.id === userId) {
      throw badRequest('You are already at this table');
    }

    if (invited) {
      const alreadyMember = await this.prisma.tableMember.findUnique({
        where: { tableId_userId: { tableId, userId: invited.id } },
      });

      if (alreadyMember) {
        throw conflict('This player is already at the table');
      }

      // Bloquer promet de ne plus rien recevoir de quelqu'un, et c'est ici
      // que la promesse se tient. Le message ne dit pas pourquoi : apprendre
      // qu'on a été bloqué est précisément ce que le geste évite, et il
      // suffirait sinon d'une invitation pour sonder tout un carnet
      // d'adresses.
      const blocked = await this.prisma.userBlock.findUnique({
        where: {
          blockerId_blockedId: { blockerId: invited.id, blockedId: userId },
        },
        select: { id: true },
      });

      if (blocked) {
        throw forbidden('Cette personne ne peut pas être invitée.');
      }
    }

    const existing = await this.prisma.tableInvitation.findUnique({
      where: { tableId_email: { tableId, email } },
    });

    if (existing?.status !== 'pending') {
      await this.assertTableHasRoom(tableId);
      await this.assertInviteQuota(userId);
    }

    const token = randomToken();
    const expiresAt = new Date(
      Date.now() + this.options.invitationTtlDays * 24 * 60 * 60 * 1000,
    );

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: tableId },
      select: { title: true },
    });

    const inviter = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const inviterName = displayNameOf(toTableUserDto(inviter));

    const draft: NotificationDraft | null = invited
      ? {
          userId: invited.id,
          type: 'table_invitation',
          title: 'Invitation à une table',
          body: `${inviterName} t'invite à rejoindre « ${table.title} »`,
          tableId,
        }
      : null;

    const invitation = await this.prisma.$transaction(async (tx) => {
      const row = await tx.tableInvitation.upsert({
        where: { tableId_email: { tableId, email } },
        create: {
          tableId,
          email,
          invitedUserId: invited?.id ?? null,
          invitedById: userId,
          tokenHash: hashToken(token),
          expiresAt,
        },
        update: {
          invitedUserId: invited?.id ?? null,
          invitedById: userId,
          tokenHash: hashToken(token),
          status: 'pending',
          expiresAt,
          respondedAt: null,
        },
        include: { invitedBy: true, table: { select: { title: true } } },
      });

      if (draft) {
        await this.notifications.record(tx, [draft]);
      }
      return row;
    });

    if (draft) {
      this.notifications.deliver([draft]);
    }

    const acceptUrl = `${this.options.publicBaseUrl}/invitations/${token}`;
    try {
      await this.email.send(
        renderInvitationEmail({
          to: email,
          tableTitle: table.title,
          inviterName,
          acceptUrl,
        }),
      );
    } catch (error) {
      // The invitation exists and is visible in the app, so a mail provider
      // outage must not fail the request.
      this.notifications.logSendFailure(error, 'invitation email');
    }

    return toInvitationDto(invitation);
  }

  async revokeInvitation(
    userId: string,
    tableId: string,
    invitationId: string,
  ): Promise<void> {
    await requireGameMaster(this.prisma, userId, tableId);

    const updated = await this.prisma.tableInvitation.updateMany({
      where: { id: invitationId, tableId, status: 'pending' },
      data: { status: 'revoked', respondedAt: new Date() },
    });

    if (updated.count === 0) {
      throw notFound('Invitation not found');
    }
  }

  async listMyInvitations(userId: string): Promise<TableInvitationDto[]> {
    const rows = await this.prisma.tableInvitation.findMany({
      where: { invitedUserId: userId, status: 'pending', expiresAt: { gt: new Date() } },
      include: { invitedBy: true, table: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(toInvitationDto);
  }

  async respondToInvitation(
    userId: string,
    invitationId: string,
    accept: boolean,
  ): Promise<GameTableDto | null> {
    const invitation = await this.prisma.tableInvitation.findFirst({
      where: { id: invitationId, invitedUserId: userId },
    });

    if (!invitation) {
      throw notFound('Invitation not found');
    }

    return this.settle(invitation.id, userId, accept);
  }

  /// What the page behind the emailed link shows. It only reads: a mail client
  /// prefetching links must not be able to spend the code.
  async previewByToken(
    token: string,
  ): Promise<{ tableTitle: string; inviterName: string }> {
    const invitation = await this.prisma.tableInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { table: { select: { title: true } }, invitedBy: true },
    });

    if (!invitation) {
      throw notFound('Cette invitation n’existe pas.');
    }

    assertRedeemable(invitation);

    return {
      tableTitle: invitation.table.title,
      inviterName: displayNameOf(toTableUserDto(invitation.invitedBy)),
    };
  }

  /// Le code du lien envoye par e-mail, echange par le compte connecte.
  ///
  /// L'adresse de l'invitation ne compte plus : un compte Apple n'a souvent
  /// qu'une adresse de relais, que le MJ ne connait pas. C'est la possession du
  /// code qui fait foi, d'ou l'usage unique — une fois echange, il n'ouvre
  /// plus la table a personne d'autre.
  async redeem(userId: string, code: string): Promise<GameTableDto> {
    const invitation = await this.prisma.tableInvitation.findUnique({
      where: { tokenHash: hashToken(code) },
      select: {
        id: true,
        tableId: true,
        status: true,
        expiresAt: true,
        invitedUserId: true,
      },
    });

    if (!invitation) {
      throw notFound('Cette invitation n’existe pas.');
    }

    // Le meme compte qui rouvre son lien, ou une requete rejouee apres une
    // coupure reseau : il est deja a la table, c'est un succes.
    if (invitation.status === 'accepted' && invitation.invitedUserId === userId) {
      return this.get(userId, invitation.tableId);
    }

    assertRedeemable(invitation);

    const member = await this.prisma.tableMember.findUnique({
      where: { tableId_userId: { tableId: invitation.tableId, userId } },
      select: { id: true },
    });

    // Le code n'est pas consomme : il reste a qui il etait destine.
    if (member) {
      throw conflict('Tu fais déjà partie de cette table.');
    }

    // Un blocage, dans un sens ou dans l'autre, avec quiconque est assis a
    // la table. Bloquer en fait sortir les deux comptes ; un code ne doit pas
    // les y rasseoir. Le message ne dit pas pourquoi, pour la meme raison
    // qu'a l'invitation.
    const blocked = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: userId, blocked: { memberships: { some: { tableId: invitation.tableId } } } },
          { blockedId: userId, blocker: { memberships: { some: { tableId: invitation.tableId } } } },
        ],
      },
      select: { id: true },
    });

    if (blocked) {
      throw forbidden('Tu ne peux pas rejoindre cette table.');
    }

    const table = await this.settle(invitation.id, userId, true);
    return table!;
  }

  private async settle(
    invitationId: string,
    userId: string,
    accept: boolean,
  ): Promise<GameTableDto | null> {
    const invitation = await this.prisma.tableInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      include: { table: { select: { title: true, id: true } } },
    });

    assertRedeemable(invitation);

    const player = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const playerName = publicLabel(player);
    const draft: NotificationDraft = {
      userId: invitation.invitedById,
      type: 'invitation_accepted',
      title: accept ? 'Invitation acceptée' : 'Invitation déclinée',
      body: accept
        ? `${playerName} rejoint « ${invitation.table.title} »`
        : `${playerName} ne rejoindra pas « ${invitation.table.title} »`,
      tableId: invitation.tableId,
    };

    await this.prisma.$transaction(async (tx) => {
      // Conditionnel, et non une simple mise a jour : deux comptes qui
      // echangent le meme code au meme instant passent tous deux les
      // controles ci-dessus, et seul le premier doit entrer.
      const spent = await tx.tableInvitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: {
          status: accept ? 'accepted' : 'declined',
          respondedAt: new Date(),
          invitedUserId: userId,
        },
      });

      if (spent.count === 0) {
        throw conflict('Cette invitation a déjà été utilisée.');
      }

      if (accept) {
        // Idempotent: accepting twice in quick succession, e.g. by double
        // clicking the emailed link, must not blow up on the unique index.
        await tx.tableMember.upsert({
          where: { tableId_userId: { tableId: invitation.tableId, userId } },
          create: { tableId: invitation.tableId, userId, role: 'player' },
          update: {},
        });
      }

      await this.notifications.record(tx, [draft]);
    });

    this.notifications.deliver([draft]);

    return accept ? this.get(userId, invitation.tableId) : null;
  }

  // --- Helpers ---

  /// Exposed for the session service, which notifies the same audience.
  async memberIds(tableId: string): Promise<string[]> {
    return memberUserIds(this.prisma, tableId);
  }

  private async assertTableHasRoom(tableId: string): Promise<void> {
    const [players, pending] = await Promise.all([
      this.prisma.tableMember.count({ where: { tableId, role: 'player' } }),
      this.prisma.tableInvitation.count({
        where: { tableId, status: 'pending', expiresAt: { gt: new Date() } },
      }),
    ]);

    if (players + pending >= MAX_PLAYERS_PER_TABLE) {
      throw conflict('Cette table a déjà 8 joueurs.');
    }
  }

  private async assertInviteQuota(userId: string): Promise<void> {
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const sentToday = await this.prisma.tableInvitation.count({
      where: { invitedById: userId, createdAt: { gte: startOfUtcDay } },
    });

    if (sentToday >= MAX_INVITES_PER_DAY) {
      throw tooManyRequests('Tu as déjà envoyé 15 invitations aujourd’hui.');
    }
  }

  private toDto(row: TableWithRelations, viewerId: string): GameTableDto {
    const viewer = row.members.find((member) => member.userId === viewerId);

    return {
      id: row.id,
      title: row.title,
      universeLabel: row.universeLabel,
      ownerId: row.ownerId,
      role: (viewer?.role ?? 'player') as MemberRole,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      members: row.members.map((member) => ({
        userId: member.userId,
        role: member.role as MemberRole,
        joinedAt: member.joinedAt.toISOString(),
        user: toTableUserDto(member.user, viewerId),
      })),
      // Only the game master arranges invitations, so players are not shown
      // who else is still hesitating.
      pendingInvitations:
        viewer?.role === 'gm'
          ? row.invitations.map((invitation) =>
              toInvitationDto({ ...invitation, table: { title: row.title } }),
            )
          : [],
      nextSessionAt: row.sessions[0]?.startsAt.toISOString() ?? null,
    };
  }
}

/// Les messages remontent tels quels jusqu'a l'ecran du joueur, d'ou le
/// francais.
function assertRedeemable(invitation: { status: string; expiresAt: Date }): void {
  if (invitation.status === 'accepted') {
    throw conflict('Cette invitation a déjà été utilisée.');
  }

  if (invitation.status !== 'pending') {
    throw conflict('Cette invitation n’est plus valable.');
  }

  if (invitation.expiresAt.getTime() < Date.now()) {
    throw conflict('Cette invitation a expiré.');
  }
}

type InvitationRow = Prisma.TableInvitationGetPayload<{
  include: { invitedBy: true };
}> & { table: { title: string } };

function toInvitationDto(row: InvitationRow): TableInvitationDto {
  return {
    id: row.id,
    tableId: row.tableId,
    tableTitle: row.table.title,
    email: row.email,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    invitedBy: toTableUserDto(row.invitedBy),
  };
}
