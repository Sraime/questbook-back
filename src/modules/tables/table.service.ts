import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { EmailSender } from '../../lib/email-sender.js';
import type {
  NotificationDraft,
  NotificationService,
} from '../notifications/notification.service.js';
import {
  memberUserIds,
  requireGameMaster,
  requireMembership,
  toTableUserDto,
  type TableUserDto,
} from './table.access.js';
import { renderInvitationEmail } from './invitation-email.js';
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
    sessions: {
      where: { status: 'scheduled', startsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
      take: 1,
    },
  } satisfies Prisma.GameTableInclude;
}

type TableWithRelations = Prisma.GameTableGetPayload<{
  include: ReturnType<typeof tableInclude>;
}>;

function displayNameOf(user: TableUserDto): string {
  return user.displayName ?? user.email;
}

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

    await this.prisma.tableMember.delete({
      where: { tableId_userId: { tableId, userId } },
    });
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

    const deleted = await this.prisma.tableMember.deleteMany({
      where: { tableId, userId: memberUserId },
    });

    if (deleted.count === 0) {
      throw notFound('Member not found');
    }
  }

  // --- Invitations ---

  /// Only registered players can be invited, which is what lets the emailed
  /// link bind to a known account and skip a login step.
  async invite(
    userId: string,
    tableId: string,
    input: InviteInput,
  ): Promise<TableInvitationDto> {
    await requireGameMaster(this.prisma, userId, tableId);

    const email = input.email.trim().toLowerCase();
    const invited = await this.prisma.user.findUnique({ where: { email } });

    if (!invited) {
      throw notFound('No Questbook account uses this email address');
    }

    if (invited.id === userId) {
      throw badRequest('You are already at this table');
    }

    const alreadyMember = await this.prisma.tableMember.findUnique({
      where: { tableId_userId: { tableId, userId: invited.id } },
    });

    if (alreadyMember) {
      throw conflict('This player is already at the table');
    }

    const token = randomBytes(48).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.options.invitationTtlDays * 24 * 60 * 60 * 1000,
    );

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: tableId },
      select: { title: true },
    });

    const inviter = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const inviterName = displayNameOf(toTableUserDto(inviter));

    const draft: NotificationDraft = {
      userId: invited.id,
      type: 'table_invitation',
      title: 'Invitation à une table',
      body: `${inviterName} t'invite à rejoindre « ${table.title} »`,
      tableId,
    };

    // A previous invitation to the same player may have been declined or have
    // expired; re-inviting replaces it rather than piling rows up.
    const invitation = await this.prisma.$transaction(async (tx) => {
      const row = await tx.tableInvitation.upsert({
        where: { tableId_invitedUserId: { tableId, invitedUserId: invited.id } },
        create: {
          tableId,
          email,
          invitedUserId: invited.id,
          invitedById: userId,
          tokenHash: hashToken(token),
          expiresAt,
        },
        update: {
          email,
          invitedById: userId,
          tokenHash: hashToken(token),
          status: 'pending',
          expiresAt,
          respondedAt: null,
        },
        include: { invitedBy: true, table: { select: { title: true } } },
      });

      await this.notifications.record(tx, [draft]);
      return row;
    });

    this.notifications.deliver([draft]);

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

  /// Read-only counterpart of [acceptByToken], for the page the emailed link
  /// opens. It validates the invitation before showing a button that would
  /// only fail.
  async previewByToken(
    token: string,
  ): Promise<{ tableTitle: string; inviterName: string }> {
    const invitation = await this.prisma.tableInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { table: { select: { title: true } }, invitedBy: true },
    });

    if (!invitation) {
      throw notFound('Cette invitation n’existe pas ou a déjà été utilisée.');
    }

    if (invitation.status !== 'pending') {
      throw conflict('Cette invitation a déjà reçu une réponse.');
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      throw conflict('Cette invitation a expiré.');
    }

    return {
      tableTitle: invitation.table.title,
      inviterName: displayNameOf(toTableUserDto(invitation.invitedBy)),
    };
  }

  /// Reached from the emailed link, where possession of the token is the only
  /// credential. The invitation carries the account it was issued for, so no
  /// sign-in is needed to act on it.
  async acceptByToken(token: string): Promise<{ tableTitle: string }> {
    const invitation = await this.prisma.tableInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { table: { select: { title: true } } },
    });

    if (!invitation) {
      throw notFound('Invitation not found');
    }

    await this.settle(invitation.id, invitation.invitedUserId, true);
    return { tableTitle: invitation.table.title };
  }

  private async settle(
    invitationId: string,
    userId: string,
    accept: boolean,
  ): Promise<GameTableDto | null> {
    const invitation = await this.prisma.tableInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      include: {
        table: { select: { title: true, id: true } },
        invitedUser: true,
      },
    });

    if (invitation.status !== 'pending') {
      throw conflict(`This invitation was already ${invitation.status}`);
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      throw conflict('This invitation has expired');
    }

    const playerName = displayNameOf(toTableUserDto(invitation.invitedUser));
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
      await tx.tableInvitation.update({
        where: { id: invitationId },
        data: { status: accept ? 'accepted' : 'declined', respondedAt: new Date() },
      });

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
        user: toTableUserDto(member.user),
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

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
