import type { AdminUser, PrismaClient } from '@prisma/client';
import { unauthorized } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { hashToken, randomToken } from '../../lib/tokens.js';
import { verifyTotp } from '../../lib/totp.js';
import { recordAudit } from '../audit.js';

/// Consecutive failures before the account closes for a while. A password is
/// guessed by repetition, and repetition is what this cuts.
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/// Short, and pushed back by every request. A moderation evening is not
/// interrupted, and a desk left alone locks itself.
const SESSION_MINUTES = 30;

export interface AdminCredentials {
  login: string;
  password: string;
  totp: string;
}

export interface AdminSessionResult {
  token: string;
  expiresAt: Date;
  admin: PublicAdmin;
}

export interface PublicAdmin {
  id: string;
  login: string;
  lastLoginAt: Date | null;
}

export interface AuthenticatedAdmin {
  admin: PublicAdmin;
  sessionId: string;
}

const toPublicAdmin = (admin: AdminUser): PublicAdmin => ({
  id: admin.id,
  login: admin.login,
  lastLoginAt: admin.lastLoginAt,
});

/// One message for every way a sign-in can fail.
///
/// Telling a caller which half was wrong would halve the work of guessing the
/// other, and telling them the login exists would name the account worth
/// attacking. The audit log records what really happened; the caller does not.
const REJECTED = 'Identifiants invalides';

export class AdminAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  async signIn(credentials: AdminCredentials, at: Date = new Date()): Promise<AdminSessionResult> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { login: credentials.login },
    });

    if (!admin || admin.disabledAt !== null) {
      // Still spend the time a real verification would, so the response does
      // not say whether the login exists.
      await verifyPassword(credentials.password, DECOY_HASH);
      await recordAudit(this.prisma, {
        action: 'login.failure',
        details: { reason: admin ? 'disabled' : 'unknown-login' },
      });
      throw unauthorized(REJECTED);
    }

    if (admin.lockedUntil !== null && admin.lockedUntil > at) {
      await recordAudit(this.prisma, {
        adminId: admin.id,
        action: 'login.failure',
        details: { reason: 'locked', until: admin.lockedUntil.toISOString() },
      });
      throw unauthorized(REJECTED);
    }

    // Both halves are checked before either verdict is acted on: stopping at
    // the password would make the response time say it was the wrong one.
    const passwordOk = await verifyPassword(credentials.password, admin.passwordHash);
    const totpMatch = verifyTotp(admin.totpSecret, credentials.totp, at);

    // A code stays valid for its thirty seconds, so the same one could be used
    // twice by whoever read it over a shoulder. The step it belongs to must be
    // newer than the last one this account consumed.
    const totpFresh =
      totpMatch !== null &&
      (admin.lastTotpStep === null || BigInt(totpMatch.step) > admin.lastTotpStep);

    if (!passwordOk || !totpFresh) {
      await this.registerFailure(admin, at, {
        password: passwordOk ? 'ok' : 'bad',
        totp: totpMatch === null ? 'bad' : totpFresh ? 'ok' : 'replayed',
      });
      throw unauthorized(REJECTED);
    }

    const token = randomToken();
    const expiresAt = new Date(at.getTime() + SESSION_MINUTES * 60 * 1000);

    const refreshed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          failedCount: 0,
          lockedUntil: null,
          lastLoginAt: at,
          lastTotpStep: BigInt(totpMatch.step),
        },
      });

      await tx.adminSession.create({
        data: { adminId: admin.id, tokenHash: hashToken(token), expiresAt },
      });

      await recordAudit(tx, { adminId: admin.id, action: 'login.success' });

      return updated;
    });

    return { token, expiresAt, admin: toPublicAdmin(refreshed) };
  }

  /// Reads the session behind a bearer token and pushes its expiry back.
  ///
  /// The sliding window is why this writes on a read: a token that expired
  /// thirty minutes after sign-in would drop someone in the middle of a
  /// report.
  async authenticate(token: string, at: Date = new Date()): Promise<AuthenticatedAdmin> {
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { admin: true },
    });

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt <= at ||
      session.admin.disabledAt !== null
    ) {
      throw unauthorized('Session invalide ou expiree');
    }

    const expiresAt = new Date(at.getTime() + SESSION_MINUTES * 60 * 1000);
    await this.prisma.adminSession.update({
      where: { id: session.id },
      data: { expiresAt },
    });

    return { admin: toPublicAdmin(session.admin), sessionId: session.id };
  }

  /// Revoking rather than deleting: the row is what lets a session be cut
  /// short from elsewhere, and keeping it says the sign-out happened.
  async signOut(sessionId: string, adminId: string, at: Date = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.adminSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: at },
      });

      await recordAudit(tx, { adminId, action: 'logout' });
    });
  }

  private async registerFailure(
    admin: AdminUser,
    at: Date,
    details: Record<string, string>,
  ): Promise<void> {
    const failedCount = admin.failedCount + 1;
    const locked = failedCount >= MAX_FAILURES;

    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          failedCount: locked ? 0 : failedCount,
          lockedUntil: locked ? new Date(at.getTime() + LOCK_MINUTES * 60 * 1000) : null,
        },
      });

      await recordAudit(tx, {
        adminId: admin.id,
        action: 'login.failure',
        details: { ...details, ...(locked ? { locked: `${LOCK_MINUTES}m` } : {}) },
      });
    });
  }
}

/// A well-formed digest of a password nobody holds. Verifying against it costs
/// what verifying a real one costs, so an unknown login takes as long to
/// refuse as a known one — otherwise the response time would enumerate the
/// accounts worth attacking.
const DECOY_HASH = `scrypt$65536$8$1$${Buffer.alloc(16).toString(
  'base64url',
)}$${Buffer.alloc(64).toString('base64url')}`;
