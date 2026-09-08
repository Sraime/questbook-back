import type { Prisma, PrismaClient } from '@prisma/client';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import {
  readSharedCharacter,
  type CharacterDto,
} from '../characters/character.service.js';
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
  MemberRole,
  PatchSessionInput,
} from './table.schemas.js';

/// Just enough of a character to name it in the answers list. The full sheet
/// lives behind its own endpoint.
export interface AttendanceCharacterDto {
  id: string;
  name: string;
  occupation: string | null;
}

export interface AttendanceDto {
  userId: string;
  status: AttendanceStatus;
  respondedAt: string;
  user: TableUserDto;
  /// Who they are playing, when they have said. Answering and choosing a
  /// character are two separate moments.
  character: AttendanceCharacterDto | null;
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
  /// The caller's own character for this session, or null while they have not
  /// named one. Sent for the same reason as [myStatus]: the client should not
  /// have to hunt through [attendances] for its own row.
  myCharacter: AttendanceCharacterDto | null;
}

const sessionInclude = {
  attendances: {
    include: { user: true, character: true },
    orderBy: { respondedAt: 'asc' },
  },
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
    const { session } = await this.requireVisible(userId, sessionId);
    return toSessionDto(session, userId);
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
    const { session: existing } = await this.requireVisible(userId, sessionId);
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
    const { session: existing } = await this.requireVisible(userId, sessionId);
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
  ///
  /// The game master runs the evening rather than attending it, so they have
  /// nothing to answer here and are never counted among the players expected
  /// to reply.
  async setAttendance(
    userId: string,
    sessionId: string,
    status: AttendanceStatus,
    characterId?: string | null,
  ): Promise<GameSessionDto> {
    const { session: existing, role } = await this.requireVisible(userId, sessionId);

    if (role === 'gm') {
      throw forbidden('The game master runs the session rather than attending it');
    }

    if (existing.status === 'cancelled') {
      throw conflict('This session is cancelled');
    }

    if (characterId) {
      await this.requireOwnCharacter(userId, characterId);
    }

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: existing.tableId },
      select: { title: true, ownerId: true },
    });

    const playerName = await this.playerName(userId);

    const drafts: NotificationDraft[] = [
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
        create: { sessionId, userId, status, characterId: characterId ?? null },
        update: {
          status,
          respondedAt: new Date(),
          // Omitting the field leaves an earlier choice alone; only an explicit
          // null detaches it.
          ...(characterId !== undefined ? { characterId } : {}),
        },
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

  /// Naming the character one is playing, or changing one's mind about it,
  /// without touching the answer itself. Separate from [setAttendance] because
  /// the game master cares about it for a different reason: not who is coming,
  /// but who is at the table.
  async setAttendanceCharacter(
    userId: string,
    sessionId: string,
    characterId: string | null,
  ): Promise<GameSessionDto> {
    const { session: existing, role } = await this.requireVisible(userId, sessionId);

    if (role === 'gm') {
      throw forbidden('The game master runs the session rather than attending it');
    }

    if (existing.status === 'cancelled') {
      throw conflict('This session is cancelled');
    }

    const attendance = existing.attendances.find((row) => row.userId === userId);
    if (!attendance) {
      throw conflict('Answer the session before saying who you are playing');
    }

    const character = characterId
      ? await this.requireOwnCharacter(userId, characterId)
      : null;

    const table = await this.prisma.gameTable.findUniqueOrThrow({
      where: { id: existing.tableId },
      select: { title: true, ownerId: true },
    });

    const playerName = await this.playerName(userId);

    const drafts: NotificationDraft[] = [
      {
        userId: table.ownerId,
        type: 'attendance_character_changed',
        title: `Personnage · ${table.title}`,
        body: character
          ? `${playerName} jouera ${character.name} pour « ${existing.title} »`
          : `${playerName} n'a plus de personnage pour « ${existing.title} »`,
        tableId: existing.tableId,
        sessionId,
      },
    ];

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.sessionAttendance.update({
        where: { id: attendance.id },
        data: { characterId },
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

  /// A player's sheet is normally private to them; registering it for a session
  /// opens it to the others at that table, and to nobody else. Membership of
  /// the session's table is the whole authorisation.
  async getAttendanceCharacter(
    userId: string,
    sessionId: string,
    memberId: string,
  ): Promise<CharacterDto> {
    const { session } = await this.requireVisible(userId, sessionId);

    const attendance = session.attendances.find((row) => row.userId === memberId);
    if (!attendance?.characterId) {
      throw notFound('This player has not said who they are playing');
    }

    const character = await readSharedCharacter(this.prisma, attendance.characterId);
    if (!character) {
      throw notFound('Character not found');
    }

    return character;
  }

  /// 404 rather than 403, like the character module: a player must not be able
  /// to probe which character ids exist by attaching them to a session.
  private async requireOwnCharacter(
    userId: string,
    characterId: string,
  ): Promise<{ name: string }> {
    const character = await this.prisma.character.findFirst({
      where: { id: characterId, userId, deletedAt: null },
      select: { name: true },
    });

    if (!character) {
      throw notFound('Character not found');
    }

    return character;
  }

  private async playerName(userId: string): Promise<string> {
    const player = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return toTableUserDto(player).displayName ?? player.email;
  }

  /// Membership of the parent table is what grants access to a session, so the
  /// lookup and the guard always travel together. The role comes back with the
  /// session because the guard has already paid for it.
  private async requireVisible(
    userId: string,
    sessionId: string,
  ): Promise<{ session: SessionWithRelations; role: MemberRole }> {
    const session = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      include: sessionInclude,
    });

    if (!session) {
      throw notFound('Session not found');
    }

    const role = await requireMembership(this.prisma, userId, session.tableId);
    return { session, role };
  }
}

function toSessionDto(row: SessionWithRelations, viewerId: string): GameSessionDto {
  const attendances: AttendanceDto[] = row.attendances.map((attendance) => ({
    userId: attendance.userId,
    status: attendance.status as AttendanceStatus,
    respondedAt: attendance.respondedAt.toISOString(),
    user: toTableUserDto(attendance.user),
    // A character deleted since the answer was given reads as "not said yet"
    // rather than as a dangling name.
    character:
      attendance.character && attendance.character.deletedAt === null
        ? {
            id: attendance.character.id,
            name: attendance.character.name,
            occupation: attendance.character.occupation,
          }
        : null,
  }));

  const mine = attendances.find((a) => a.userId === viewerId);

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
    myStatus: mine?.status ?? null,
    myCharacter: mine?.character ?? null,
  };
}
