import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { unauthorized } from '../../lib/errors.js';
import type { GoogleVerifier } from './google-verifier.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface AuthResult extends AuthTokens {
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
}

/// Signs a short-lived access token. Injected rather than imported so the
/// service stays free of any Fastify dependency.
export type AccessTokenSigner = (payload: { sub: string; email: string }) => string;

export interface AuthServiceOptions {
  prisma: PrismaClient;
  google: GoogleVerifier;
  signAccessToken: AccessTokenSigner;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
}

/// Refresh tokens are opaque random strings; only their SHA-256 digest is
/// persisted, so a dump of `refresh_tokens` cannot be replayed.
const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  pictureUrl: user.pictureUrl,
});

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  /// Sign-up and sign-in are the same call: the first ID token for a Google
  /// account creates the user, later ones just refresh its profile.
  async signInWithGoogle(idToken: string): Promise<AuthResult> {
    const identity = await this.options.google.verify(idToken);

    const user = await this.options.prisma.user.upsert({
      where: { googleSub: identity.sub },
      create: {
        googleSub: identity.sub,
        email: identity.email,
        displayName: identity.displayName,
        pictureUrl: identity.pictureUrl,
        locale: identity.locale,
      },
      update: {
        email: identity.email,
        displayName: identity.displayName,
        pictureUrl: identity.pictureUrl,
        locale: identity.locale,
      },
    });

    const tokens = await this.issueTokens(user);
    return { ...tokens, user: toPublicUser(user) };
  }

  /// Rotates the refresh token: the presented one is revoked and a brand new
  /// pair is returned, so a stolen token is usable at most once.
  async refresh(refreshToken: string): Promise<AuthResult> {
    const stored = await this.options.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { user: true },
    });

    if (!stored || stored.revokedAt !== null || stored.expiresAt <= new Date()) {
      throw unauthorized('Refresh token is invalid, expired or already used');
    }

    await this.options.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(stored.user);
    return { ...tokens, user: toPublicUser(stored.user) };
  }

  /// Idempotent on purpose: signing out with an already-dead token is a
  /// success from the client's point of view.
  async logout(refreshToken: string): Promise<void> {
    await this.options.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.options.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async findUser(userId: string): Promise<User | null> {
    return this.options.prisma.user.findUnique({ where: { id: userId } });
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.options.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.options.prisma.refreshToken.create({
      data: { tokenHash: hashToken(refreshToken), userId: user.id, expiresAt },
    });

    return {
      accessToken: this.options.signAccessToken({ sub: user.id, email: user.email }),
      refreshToken,
      expiresIn: this.options.accessTokenTtl,
    };
  }
}
