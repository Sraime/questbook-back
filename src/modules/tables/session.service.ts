import type { Prisma, PrismaClient } from '@prisma/client';
import { conflict, notFound } from '../../lib/errors.js';
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
import type {
  AttendanceStatus,
  CreateSessionInput,
  PatchSessionInput,
} from './table.schemas.js';

export interface AttendanceDto {
  userId: string;
  status: AttendanceStatus;
  respondedAt: string;
  user: TableUserDto;
}

export interface GameSessionDto {
  id: string;
  tableId: string;
  title: string;
  description: string | null;
  startsAt: string;
  location: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  attendances: AttendanceDto[];
  /// The caller's own answer, or null while they have not replied.
  myStatus: AttendanceStatus | null;
}

const sessionInclude = {
  attendances: { include: { user: true }, orderBy: { respondedAt: 'asc' } },
} satisfies Prisma.GameSessionInclude;

type SessionWithRelations = Prisma.GameSessionGetPayload<{
  include: typeof sessionInclude;
}>;

/// Formats a session date the way the notification body reads it out, in the
/// timezone the group actually plays in. The app is French-only today, so the
/// locale is fixed rather than negotiated.
function formatWhen(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  }).format(date);
}

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
  ) {}

  async list(userId: string, tableId: string): Promise<GameSessionDto[]> {
    await requireMembership(this.prisma, userId, tableId);

    const rows = await this.prisma.gameSession.findMany({
      where: { tableId },
      include: sessionInclude,
      orderBy: { startsAt: 'asc' },
    });

    return rows.map((row) => toSessionDto(row, userId));
  }

  async get(userId: string, sessionId: string): Promise<GameSessionDto> {
    const row = await this.requireVisible(userId, sessionId);
    return toSessionDto(row, userId);
  }

  async create(
    userId: string,
    tableId: string,
    input: CreateSessionInput,
  ): Promise<GameSessionDto> {
    await requireGameMaster(this.prisma, userId, tableId);

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: tableId },
      select: { title: true },
    });

    const startsAt = new Date(input.startsAt);
    const audience = (await memberUserIds(this.prisma, tableId)).filter(
      (id) => id !== userId,
    );

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.gameSession.create({
        data: {
          tableId,
          title: input.title,
          description: input.description ?? null,
          startsAt,
          location: input.location,
        },
        include: sessionInclude,
      });

      await this.notifications.record(
        tx,
        audience.map((memberId) => ({
          userId: memberId,
          type: 'session_created' as const,
          title: `Nouvelle session · ${table.title}`,
          body: `${input.title}, ${formatWhen(startsAt)}, ${input.location}`,
          tableId,
          sessionId: created.id,
        })),
      );

      return created;
    });

    this.notifications.deliver(
      audience.map((memberId) => ({
        userId: memberId,
        type: 'session_created',
        title: `Nouvelle session · ${table.title}`,
        body: `${input.title}, ${formatWhen(startsAt)}, ${input.location}`,
        tableId,
        sessionId: row.id,
      })),
    );

    return toSessionDto(row, userId);
  }

  /// Changing the date or the place is what players need to hear about; a typo
  /// fixed in the description is not worth a push at three in the morning.
  async patch(
    userId: string,
    sessionId: string,
    input: PatchSessionInput,
  ): Promise<GameSessionDto> {
    const existing = await this.requireVisible(userId, sessionId);
    await requireGameMaster(this.prisma, userId, existing.tableId);

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: existing.tableId },
      select: { title: true },
    });

    const startsAt = input.startsAt ? new Date(input.startsAt) : existing.startsAt;
    const location = input.location ?? existing.location;

    const scheduleChanged =
      startsAt.getTime() !== existing.startsAt.getTime() || location !== existing.location;

    const audience = scheduleChanged
      ? (await memberUserIds(this.prisma, existing.tableId)).filter((id) => id !== userId)
      : [];

    const drafts: NotificationDraft[] = audience.map((memberId) => ({
      userId: memberId,
      type: 'session_updated',
      title: `Session modifiée · ${table.title}`,
      body: `${input.title ?? existing.title}, ${formatWhen(startsAt)}, ${location}`,
      tableId: existing.tableId,
      sessionId,
    }));

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.gameSession.update({
        where: { id: sessionId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined
            ? { description: input.description ?? null }
            : {}),
          ...(input.startsAt !== undefined ? { startsAt } : {}),
          ...(input.location !== undefined ? { location } : {}),
        },
        include: sessionInclude,
      });

      await this.notifications.record(tx, drafts);
      return updated;
    });

    this.notifications.deliver(drafts);

    return toSessionDto(row, userId);
  }

  async cancel(userId: string, sessionId: string): Promise<GameSessionDto> {
    const existing = await this.requireVisible(userId, sessionId);
    await requireGameMaster(this.prisma, userId, existing.tableId);

    if (existing.status === 'cancelled') {
      throw conflict('This session is already cancelled');
    }

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: existing.tableId },
      select: { title: true },
    });

    const audience = (await memberUserIds(this.prisma, existing.tableId)).filter(
      (id) => id !== userId,
    );

    const drafts: NotificationDraft[] = audience.map((memberId) => ({
      userId: memberId,
      type: 'session_cancelled',
      title: `Session annulée · ${table.title}`,
      body: `${existing.title}, prévue ${formatWhen(existing.startsAt)}`,
      tableId: existing.tableId,
      sessionId,
    }));

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.gameSession.update({
        where: { id: sessionId },
        data: { status: 'cancelled' },
        include: sessionInclude,
      });

      await this.notifications.record(tx, drafts);
      return updated;
    });

    this.notifications.deliver(drafts);

    return toSessionDto(row, userId);
  }

  /// Answering and changing one's mind are the same operation: the game master
  /// is notified either way, which is the whole point of the feature.
  async setAttendance(
    userId: string,
    sessionId: string,
    status: AttendanceStatus,
  ): Promise<GameSessionDto> {
    const existing = await this.requireVisible(userId, sessionId);

    if (existing.status === 'cancelled') {
      throw conflict('This session is cancelled');
    }

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: existing.tableId },
      select: { title: true, ownerId: true },
    });

    const player = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const playerName = toTableUserDto(player).displayName ?? player.email;

    const drafts: NotificationDraft[] =
      table.ownerId === userId
        ? []
        : [
            {
              userId: table.ownerId,
              type: 'attendance_changed',
              title: `Réponse · ${table.title}`,
              body:
                status === 'yes'
                  ? `${playerName} sera présent pour « ${existing.title} »`
                  : `${playerName} ne sera pas là pour « ${existing.title} »`,
              tableId: existing.tableId,
              sessionId,
            },
          ];

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.sessionAttendance.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        create: { sessionId, userId, status },
        update: { status, respondedAt: new Date() },
      });

      await this.notifications.record(tx, drafts);

      return tx.gameSession.findUniqueOrThrow({
        where: { id: sessionId },
        include: sessionInclude,
      });
    });

    this.notifications.deliver(drafts);

    return toSessionDto(row, userId);
  }

  /// Membership of the parent table is what grants access to a session, so the
  /// lookup and the guard always travel together.
  private async requireVisible(
    userId: string,
    sessionId: string,
  ): Promise<SessionWithRelations> {
    const row = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      include: sessionInclude,
    });

    if (!row) {
      throw notFound('Session not found');
    }

    await requireMembership(this.prisma, userId, row.tableId);
    return row;
  }
}

function toSessionDto(row: SessionWithRelations, viewerId: string): GameSessionDto {
  const attendances: AttendanceDto[] = row.attendances.map((attendance) => ({
    userId: attendance.userId,
    status: attendance.status as AttendanceStatus,
    respondedAt: attendance.respondedAt.toISOString(),
    user: toTableUserDto(attendance.user),
  }));

  return {
    id: row.id,
    tableId: row.tableId,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt.toISOString(),
    location: row.location,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    attendances,
    myStatus: attendances.find((a) => a.userId === viewerId)?.status ?? null,
  };
}
