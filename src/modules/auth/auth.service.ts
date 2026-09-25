import type { PrismaClient, User } from '@prisma/client';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { hashToken, randomToken } from '../../lib/tokens.js';
import type { AppleVerifier } from './apple-verifier.js';
import type { GoogleVerifier } from './google-verifier.js';
import { grantStarterScenarios } from '../scenarios/scenario.service.js';

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

  /// Nul tant que le compte n'a pas accepté les conditions d'utilisation.
  /// Voyage avec chaque réponse d'authentification — connexion, rafraîchisse-
  /// ment, `/me` — parce que l'app barre l'écran là-dessus : le lui faire
  /// demander à part ajouterait un appel là où il n'en faut aucun.
  termsAcceptedAt: string | null;
}

/// Signs a short-lived access token. Injected rather than imported so the
/// service stays free of any Fastify dependency.
export type AccessTokenSigner = (payload: { sub: string }) => string;

export interface AuthServiceOptions {
  prisma: PrismaClient;
  google: GoogleVerifier;
  apple: AppleVerifier;
  signAccessToken: AccessTokenSigner;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
}

export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  pictureUrl: user.pictureUrl,
  termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
});

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  /// Sign-up and sign-in are the same call: the first ID token for a Google
  /// account creates the user, later ones just refresh its profile.
  ///
  /// Everything is refreshed from Google except the display name. Google gives
  /// the first one, and from then on the pseudonym belongs to Questbook: a
  /// player who renamed themselves here would otherwise be silently renamed
  /// back at their next sign-in.
  async signInWithGoogle(idToken: string): Promise<AuthResult> {
    const identity = await this.options.google.verify(idToken);

    const user = await this.options.prisma.user.upsert({
      where: { googleSub: identity.sub },
      create: {
        googleSub: identity.sub,
        email: identity.email.trim().toLowerCase(),
        displayName: identity.displayName,
        pictureUrl: identity.pictureUrl,
        locale: identity.locale,
      },
      update: {
        email: identity.email.trim().toLowerCase(),
        pictureUrl: identity.pictureUrl,
        locale: identity.locale,
      },
    });

    await this.claimInvitations(user.id, user.email);
    await grantStarterScenarios(this.options.prisma, user.id);

    const tokens = await this.issueTokens(user);
    return { ...tokens, user: toPublicUser(user) };
  }

  /// Même porte que `signInWithGoogle`, pour le fournisseur qu'Apple impose à
  /// toute app dont la seule connexion est un service tiers.
  ///
  /// Trois différences avec Google, et elles viennent toutes du jeton :
  ///
  /// - **Il ne porte ni nom ni photo.** Apple ne remet le nom qu'une fois, au
  ///   client, à la toute première autorisation. C'est donc lui qui le passe
  ///   ici, et on ne lui fait pas plus confiance qu'au renommage : le joueur
  ///   peut le changer ensuite, et c'est tout ce que ce champ vaut.
  /// - **L'adresse peut manquer**, si le compte a été autorisé sans la
  ///   partager. Une table s'invite par adresse : sans elle, il n'y a pas de
  ///   compte à créer, et le dire vaut mieux qu'inventer une adresse interne.
  /// - **Rien ne se rafraîchit aux connexions suivantes.** L'adresse d'un
  ///   relais privé est stable, et c'est la seule chose qu'Apple redonne.
  async signInWithApple(identityToken: string, displayName?: string): Promise<AuthResult> {
    const identity = await this.options.apple.verify(identityToken);

    const existing = await this.options.prisma.user.findUnique({
      where: { appleSub: identity.sub },
    });

    if (existing) {
      const tokens = await this.issueTokens(existing);
      return { ...tokens, user: toPublicUser(existing) };
    }

    if (!identity.email) {
      throw badRequest(
        'Apple account shared no email address, which Questbook needs to invite you to a table',
      );
    }
    if (!identity.emailVerified) {
      throw unauthorized('Apple account email is not verified');
    }

    const email = identity.email.trim().toLowerCase();
    const trimmedName = displayName?.trim();

    const user = await this.options.prisma.user
      .create({
        data: {
          appleSub: identity.sub,
          email,
          displayName: trimmedName && trimmedName.length > 0 ? trimmedName : null,
        },
      })
      .catch((cause: unknown) => {
        // Cette adresse a déjà un compte, créé par une connexion Google. Les
        // rapprocher demanderait de prouver que c'est le même humain, ce
        // qu'aucun des deux jetons ne dit ; le refus nommé laisse au moins le
        // joueur revenir par la porte qu'il connaît.
        if ((cause as { code?: string }).code === 'P2002') {
          throw conflict('This email already signs in to Questbook with Google');
        }
        throw cause;
      });

    await this.claimInvitations(user.id, user.email);
    await grantStarterScenarios(this.options.prisma, user.id);

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

  /// Erases the account and everything the database hangs off it: characters,
  /// memberships, answers, notifications, purchases, and the tables the user
  /// runs — with the sessions and memberships of the players who had joined
  /// them. Every relation to `User` cascades, so one delete is the whole of it.
  ///
  /// This destroys other people's data, which is deliberate: a table without
  /// its game master is a dead room, and there is no way to hand it over from
  /// here. The client is the one that must say so before calling.
  ///
  /// Idempotent: deleting an account that is already gone is a success.
  async deleteAccount(userId: string): Promise<void> {
    await this.options.prisma.user.deleteMany({ where: { id: userId } });
  }

  /// Renames the account. The display name is the only thing a user may change
  /// about their profile: the email and the picture belong to Google.
  async rename(userId: string, displayName: string): Promise<PublicUser> {
    const user = await this.options.prisma.user
      .update({ where: { id: userId }, data: { displayName } })
      .catch(() => null);

    if (!user) {
      throw unauthorized('Account no longer exists');
    }
    return toPublicUser(user);
  }

  /// Enregistre l'acceptation des conditions d'utilisation.
  ///
  /// Idempotent, mais **sans réécrire la date** : ce qui compte est le moment
  /// où le compte a dit oui, et un second appel — l'app relancée deux fois
  /// sur un réseau capricieux — ne doit pas le déplacer.
  async acceptTerms(userId: string): Promise<PublicUser> {
    const user = await this.options.prisma.user
      .findUnique({ where: { id: userId } })
      .catch(() => null);

    if (!user) {
      throw unauthorized('Account no longer exists');
    }
    if (user.termsAcceptedAt) return toPublicUser(user);

    return toPublicUser(
      await this.options.prisma.user.update({
        where: { id: userId },
        data: { termsAcceptedAt: new Date() },
      }),
    );
  }

  /// Invitations sent to a mailbox before it had an account become visible
  /// the moment that address signs in.
  private async claimInvitations(userId: string, email: string): Promise<void> {
    await this.options.prisma.tableInvitation.updateMany({
      where: { email, invitedUserId: null, status: 'pending' },
      data: { invitedUserId: userId },
    });
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const refreshToken = randomToken();
    const expiresAt = new Date(
      Date.now() + this.options.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.options.prisma.refreshToken.create({
      data: { tokenHash: hashToken(refreshToken), userId: user.id, expiresAt },
    });

    return {
      accessToken: this.options.signAccessToken({ sub: user.id }),
      refreshToken,
      expiresIn: this.options.accessTokenTtl,
    };
  }
}
