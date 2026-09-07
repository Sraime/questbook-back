import type { FastifyBaseLogger } from 'fastify';
import type { Notification, Prisma, PrismaClient } from '@prisma/client';
import type { PushSender } from '../../lib/push-sender.js';

/// Kept in sync with the Flutter client, which switches on it to decide where
/// tapping a notification should navigate.
export type NotificationType =
  | 'table_invitation'
  | 'invitation_accepted'
  | 'session_created'
  | 'session_updated'
  | 'session_cancelled'
  | 'attendance_changed';

export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  tableId?: string | null;
  sessionId?: string | null;
}

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  tableId: string | null;
  sessionId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface DeviceRegistrationInput {
  token: string;
  platform: string;
}

export function toNotificationDto(row: Notification): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    tableId: row.tableId,
    sessionId: row.sessionId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly push: PushSender,
    private readonly logger: FastifyBaseLogger,
  ) {}

  // --- Writing ---

  /// Called inside the caller's transaction so a notification can never
  /// outlive the change that justified it.
  async record(
    tx: Prisma.TransactionClient,
    drafts: NotificationDraft[],
  ): Promise<void> {
    if (drafts.length === 0) return;

    await tx.notification.createMany({
      data: drafts.map((draft) => ({
        userId: draft.userId,
        type: draft.type,
        title: draft.title,
        body: draft.body,
        tableId: draft.tableId ?? null,
        sessionId: draft.sessionId ?? null,
      })),
    });
  }

  /// Fire-and-forget push, called once the transaction has committed. It
  /// swallows every failure on purpose: the notification is already stored, so
  /// the user will still see it, and a dead Firebase must not turn a
  /// successful write into a 500.
  deliver(drafts: NotificationDraft[]): void {
    if (drafts.length === 0) return;

    void this.sendPush(drafts).catch((error) => {
      this.logger.error({ err: error }, 'Push delivery failed');
    });
  }

  /// Shared by callers that send email alongside a notification: the record is
  /// already committed, so a failed delivery is worth logging and nothing more.
  logSendFailure(error: unknown, what: string): void {
    this.logger.error({ err: error }, `Delivery failed: ${what}`);
  }

  private async sendPush(drafts: NotificationDraft[]): Promise<void> {
    const userIds = [...new Set(drafts.map((draft) => draft.userId))];
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, token: true },
    });

    if (devices.length === 0) return;

    const tokensByUser = new Map<string, string[]>();
    for (const device of devices) {
      const existing = tokensByUser.get(device.userId) ?? [];
      existing.push(device.token);
      tokensByUser.set(device.userId, existing);
    }

    const stale: string[] = [];

    for (const draft of drafts) {
      const tokens = tokensByUser.get(draft.userId);
      if (!tokens || tokens.length === 0) continue;

      const result = await this.push.send({
        tokens,
        title: draft.title,
        body: draft.body,
        data: {
          type: draft.type,
          ...(draft.tableId ? { tableId: draft.tableId } : {}),
          ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
        },
      });
      stale.push(...result.staleTokens);
    }

    if (stale.length > 0) {
      await this.prisma.deviceToken.deleteMany({ where: { token: { in: stale } } });
    }
  }

  // --- Reading ---

  async list(userId: string, limit = 50): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toNotificationDto);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /// Idempotent, and scoped to the caller: passing someone else's id simply
  /// matches nothing rather than leaking whether it exists.
  async markRead(userId: string, ids: string[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, id: { in: ids }, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  // --- Devices ---

  /// The same token can move between accounts when two people share a device,
  /// so registration reassigns rather than failing on the unique constraint.
  async registerDevice(userId: string, input: DeviceRegistrationInput): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token: input.token },
      create: { userId, token: input.token, platform: input.platform },
      update: { userId, platform: input.platform, lastSeenAt: new Date() },
    });
  }

  async unregisterDevice(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }
}
