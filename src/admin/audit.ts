import type { Prisma, PrismaClient } from '@prisma/client';

/// Either the client or an open transaction, so a caller can write its audit
/// line in the same transaction as the action it records.
export type AuditClient = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  /// Absent when the attempt identified nobody — a sign-in on an unknown login
  /// deserves its line as much as a successful one.
  adminId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/// Writes what the administration did.
///
/// This is the only component of the product that can read everyone's data and
/// delete someone's account, so the trace is not optional. Call it **inside**
/// the transaction of the action it records, the way the notifications already
/// are: a journal written afterwards misses exactly the cases where it would
/// have mattered — the ones that failed halfway.
///
/// Never pass a secret in `details`: no password, no code, no session token.
export async function recordAudit(client: AuditClient, entry: AuditEntry): Promise<void> {
  await client.adminAuditEntry.create({
    data: {
      adminId: entry.adminId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details === undefined ? null : JSON.stringify(entry.details),
    },
  });
}
