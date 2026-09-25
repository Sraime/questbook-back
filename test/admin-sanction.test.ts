import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminTestApp,
  createTestApp,
  prisma,
  resetDatabase,
  seedAdmin,
  signIn,
  totpFor,
  type SeededAdmin,
  type SignedInUser,
  type TestContext,
} from './helpers/test-app.js';
import { createTable } from './helpers/tables.js';

let product: TestContext;
let admin: FastifyInstance;
let account: SeededAdmin;
let authHeader: { authorization: string };

beforeEach(async () => {
  await resetDatabase();
  product = await createTestApp();
  admin = await createAdminTestApp();
  account = await seedAdmin();

  const signedIn = await admin.inject({
    method: 'POST',
    url: '/admin/auth/session',
    payload: { login: account.login, password: account.password, totp: totpFor(account) },
  });
  authHeader = { authorization: `Bearer ${signedIn.json().token}` };
});

afterAll(async () => {
  await prisma.$disconnect();
});

const suspend = (userId: string, body: Record<string, unknown> = { reason: 'Harcelement.' }) =>
  admin.inject({
    method: 'POST',
    url: `/admin/users/${userId}/suspend`,
    headers: authHeader,
    payload: body,
  });

const lift = (userId: string) =>
  admin.inject({ method: 'DELETE', url: `/admin/users/${userId}/suspend`, headers: authHeader });

describe('suspending an account', () => {
  it('records when, until when, and why', async () => {
    const user = await signIn(product, 'genant');
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const response = await suspend(user.userId, { until, reason: 'Propos insultants.' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      suspended: true,
      suspendedUntil: until,
      suspensionReason: 'Propos insultants.',
    });
  });

  it('demands a reason, because a sanction nobody can contest is not one', async () => {
    const user = await signIn(product, 'genant');

    expect((await suspend(user.userId, { reason: '' })).statusCode).toBe(400);
    expect((await suspend(user.userId, {})).statusCode).toBe(400);
  });

  it('refuses a suspension that expired before it began', async () => {
    const user = await signIn(product, 'genant');

    const response = await suspend(user.userId, {
      until: new Date(Date.now() - 1000).toISOString(),
      reason: 'Trop tard.',
    });

    expect(response.statusCode).toBe(400);
  });

  it('is closed to anyone without an admin session', async () => {
    const user = await signIn(product, 'genant');

    const response = await admin.inject({
      method: 'POST',
      url: `/admin/users/${user.userId}/suspend`,
      payload: { reason: 'Sans session.' },
    });

    expect(response.statusCode).toBe(401);
  });
});

/// The whole point of the card. A measure that only bites in three of the four
/// places is a measure someone walks around, and the walk-around is never the
/// one you watched.
describe('where a suspension bites', () => {
  const suspendedBody = (response: { json: () => { error: { code: string } } }) =>
    response.json().error;

  it('stops the access token already in hand', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, { reason: 'Harcelement.' });

    const response = await product.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: user.authHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(suspendedBody(response).code).toBe('ACCOUNT_SUSPENDED');
  });

  it('stops signing in again with Google', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, { reason: 'Harcelement.' });

    const response = await product.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'id-token-genant' },
    });

    expect(response.statusCode).toBe(403);
    expect(suspendedBody(response).code).toBe('ACCOUNT_SUSPENDED');
  });

  it('stops signing in again with Apple', async () => {
    product.apple.register('apple-genant', { sub: 'apple-sub-genant' });
    const signedIn = await product.app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      payload: { identityToken: 'apple-genant' },
    });
    expect(signedIn.statusCode).toBe(200);

    await suspend(signedIn.json().user.id, { reason: 'Harcelement.' });

    const again = await product.app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      payload: { identityToken: 'apple-genant' },
    });

    expect(again.statusCode).toBe(403);
    expect(suspendedBody(again).code).toBe('ACCOUNT_SUSPENDED');
  });

  /// Suspending revokes the tokens of the account, so this one covers the
  /// token issued in between — the race the revocation alone would lose.
  it('stops a refresh token issued before the measure', async () => {
    const user = await signIn(product, 'genant');
    await prisma.user.update({
      where: { id: user.userId },
      data: { suspendedAt: new Date(), suspensionReason: 'Pose sans revoquer.' },
    });

    const response = await product.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(response.statusCode).toBe(403);
    expect(suspendedBody(response).code).toBe('ACCOUNT_SUSPENDED');
  });

  it('revokes the refresh tokens of the account as it suspends', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, { reason: 'Harcelement.' });

    const tokens = await prisma.refreshToken.findMany({ where: { userId: user.userId } });
    expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
  });

  /// They are meant to read it: a 404 would be pointless when we are talking
  /// to the very person the measure is aimed at, and letting them believe in
  /// an outage would only make them come back ten times.
  it('says why, and until when', async () => {
    const user = await signIn(product, 'genant');
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await suspend(user.userId, { until, reason: 'Propos insultants envers un autre joueur.' });

    const response = await product.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: user.authHeader,
    });

    expect(response.json().error.details).toEqual({
      reason: 'Propos insultants envers un autre joueur.',
      until,
    });
  });

  it('leaves everyone else alone', async () => {
    const genant = await signIn(product, 'genant');
    const autre = await signIn(product, 'autre');
    await suspend(genant.userId, { reason: 'Harcelement.' });

    const response = await product.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: autre.authHeader,
    });

    expect(response.statusCode).toBe(200);
  });
});

/// No scheduler here, so it is read at each check rather than swept by a
/// background task: a column nobody clears would keep someone out forever.
describe('a dated suspension', () => {
  it('expires on its own', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, {
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'Vingt-quatre heures.',
    });

    expect(
      (
        await product.app.inject({
          method: 'GET',
          url: '/api/v1/characters',
          headers: user.authHeader,
        })
      ).statusCode,
    ).toBe(403);

    await prisma.user.update({
      where: { id: user.userId },
      data: { suspendedUntil: new Date(Date.now() - 1000) },
    });

    expect(
      (
        await product.app.inject({
          method: 'GET',
          url: '/api/v1/characters',
          headers: user.authHeader,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('is lifted by hand too, and the account works again', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, { reason: 'Erreur.' });

    const lifted = await lift(user.userId);
    expect(lifted.statusCode).toBe(200);
    expect(lifted.json()).toMatchObject({
      suspended: false,
      suspendedAt: null,
      suspensionReason: null,
    });

    // Les jetons ont ete revoques : il faut se reconnecter, et cela marche.
    const again = await product.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'id-token-genant' },
    });
    expect(again.statusCode).toBe(200);
  });
});

describe('closing an account', () => {
  const remove = (userId: string, confirmEmail: string) =>
    admin.inject({
      method: 'DELETE',
      url: `/admin/users/${userId}`,
      headers: authHeader,
      payload: { confirmEmail },
    });

  /// It is the only place in the product where a third party destroys someone
  /// else's data, and it carries away the tables they ran. The typed address
  /// is what stands between a decision and a slip of the mouse.
  it('demands the address of the account, and refuses a mismatch', async () => {
    const user = await signIn(product, 'genant');

    expect((await remove(user.userId, 'pas@la-bonne.example')).statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { id: user.userId } })).not.toBeNull();
  });

  it('closes the account and takes its tables with it', async () => {
    const gm = await signIn(product, 'genant');
    await createTable(product, gm, 'Une table a faire disparaitre');

    const response = await remove(gm.userId, gm.email);

    expect(response.statusCode).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: gm.userId } })).toBeNull();
    expect(await prisma.gameTable.count()).toBe(0);
  });

  it('shows what would be destroyed before it is asked for', async () => {
    const gm = await signIn(product, 'genant');
    await createTable(product, gm, 'Une table');

    const response = await admin.inject({
      method: 'GET',
      url: `/admin/users/${gm.userId}`,
      headers: authHeader,
    });

    expect(response.json()).toMatchObject({ email: gm.email, ownedTables: 1 });
  });

  /// `admin_audit_log` does not point at `users`, but a trace that vanished
  /// with what it traces would be worth nothing.
  it('leaves a trace that survives the account', async () => {
    const gm = await signIn(product, 'genant');
    await createTable(product, gm, 'Une table');
    await remove(gm.userId, gm.email);

    const entry = await prisma.adminAuditEntry.findFirstOrThrow({
      where: { action: 'user.delete' },
    });

    expect(entry.targetId).toBe(gm.userId);
    expect(JSON.parse(entry.details ?? '{}')).toMatchObject({
      email: gm.email,
      ownedTables: 1,
    });
  });

  it('answers 404 for an unknown account', async () => {
    const response = await remove('2f1b8c4e-0000-4000-8000-000000000000', 'x@example.com');

    expect(response.statusCode).toBe(404);
  });
});

describe('the audit log of sanctions', () => {
  it('names the account for a suspension and for its lifting', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, { reason: 'Harcelement.' });
    await lift(user.userId);

    const entries = await prisma.adminAuditEntry.findMany({
      where: { targetType: 'user' },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries.map((entry) => entry.action)).toEqual(['user.suspend', 'user.unsuspend']);
    expect(entries.every((entry) => entry.targetId === user.userId)).toBe(true);
    expect(entries.every((entry) => entry.adminId === account.id)).toBe(true);
  });

  /// The reason is shown to the player, and it is in `users`. The journal says
  /// what the administration did, not what it wrote to someone.
  it('does not copy the reason into the journal', async () => {
    const user = await signIn(product, 'genant');
    await suspend(user.userId, { reason: 'Un motif tres reconnaissable.' });

    const entry = await prisma.adminAuditEntry.findFirstOrThrow({
      where: { action: 'user.suspend' },
    });

    expect(entry.details).not.toContain('Un motif tres reconnaissable.');
  });
});
