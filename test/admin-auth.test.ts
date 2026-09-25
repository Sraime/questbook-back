import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import {
  createAdminTestApp,
  prisma,
  resetDatabase,
  seedAdmin,
  totpFor,
  type SeededAdmin,
} from './helpers/test-app.js';

let app: FastifyInstance;
let admin: SeededAdmin;

beforeEach(async () => {
  await resetDatabase();
  app = await createAdminTestApp();
  admin = await seedAdmin();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const signIn = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/admin/auth/session', payload: body });

const credentials = (overrides: Record<string, unknown> = {}) => ({
  login: admin.login,
  password: admin.password,
  totp: totpFor(admin),
  ...overrides,
});

const auditActions = async (): Promise<string[]> => {
  const entries = await prisma.adminAuditEntry.findMany({ orderBy: { createdAt: 'asc' } });
  return entries.map((entry) => entry.action);
};

describe('opening a back office session', () => {
  it('hands out a token for the right password and code', async () => {
    const response = await signIn(credentials());

    expect(response.statusCode).toBe(201);
    expect(response.json().token).toEqual(expect.any(String));
    expect(response.json().admin.login).toBe('robin');
    expect(new Date(response.json().expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores the token hashed, never in the clear', async () => {
    const token = (await signIn(credentials())).json().token;

    const sessions = await prisma.adminSession.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).not.toBe(token);
    expect(sessions[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  /// Saying which half was wrong would halve the work of guessing the other,
  /// and saying the login exists would name the account worth attacking.
  it('refuses a bad password and a bad code with the same answer', async () => {
    const wrongPassword = await signIn(credentials({ password: 'pas-le-bon-du-tout' }));
    const wrongCode = await signIn(credentials({ totp: '000000' }));
    const unknownLogin = await signIn(credentials({ login: 'personne' }));

    for (const response of [wrongPassword, wrongCode, unknownLogin]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toEqual({
        code: 'UNAUTHORIZED',
        message: 'Identifiants invalides',
      });
    }
  });

  /// A code lives for thirty seconds, so the one just used is still valid.
  /// Whoever read it over a shoulder must not get a second turn with it.
  it('refuses a code that has already been used', async () => {
    const code = totpFor(admin);

    expect((await signIn(credentials({ totp: code }))).statusCode).toBe(201);
    expect((await signIn(credentials({ totp: code }))).statusCode).toBe(401);
  });

  it('still accepts the next code', async () => {
    const soon = new Date(Date.now() + 30_000);

    expect((await signIn(credentials())).statusCode).toBe(201);
    expect(
      (await signIn(credentials({ totp: totpCode(admin.totpSecret, currentStep(soon)) })))
        .statusCode,
    ).toBe(201);
  });

  it('locks the account after five failures, and says no more than before', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(credentials({ password: 'non' }));
    }

    // The password and the code are both right this time, and it still fails.
    const response = await signIn(credentials());
    expect(response.statusCode).toBe(401);

    const locked = await prisma.adminUser.findUniqueOrThrow({ where: { login: admin.login } });
    expect(locked.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it('forgets the failures once a sign-in succeeds', async () => {
    await signIn(credentials({ password: 'non' }));
    await signIn(credentials({ password: 'non' }));
    await signIn(credentials());

    const refreshed = await prisma.adminUser.findUniqueOrThrow({ where: { login: admin.login } });
    expect(refreshed.failedCount).toBe(0);
    expect(refreshed.lockedUntil).toBeNull();
  });

  it('refuses a disabled account', async () => {
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { disabledAt: new Date() },
    });

    expect((await signIn(credentials())).statusCode).toBe(401);
  });

  it('refuses a code that is not six digits before reaching the service', async () => {
    const response = await signIn(credentials({ totp: '12345' }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('using a back office session', () => {
  const asAdmin = async () => {
    const token = (await signIn(credentials())).json().token;
    return { authorization: `Bearer ${token}` };
  };

  it('answers /admin/auth/me for a live session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/auth/me',
      headers: await asAdmin(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().login).toBe('robin');
  });

  it('refuses a missing, malformed or unknown token', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: 'pas-un-schema' },
      { authorization: 'Bearer jeton-invente-de-toutes-pieces' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/admin/auth/me', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });

  /// The reason for keeping sessions in a table rather than in a JWT: this is
  /// what lets a back office be signed out from elsewhere.
  it('refuses a revoked session', async () => {
    const headers = await asAdmin();
    await prisma.adminSession.updateMany({ data: { revokedAt: new Date() } });

    const response = await app.inject({ method: 'GET', url: '/admin/auth/me', headers });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an expired session', async () => {
    const headers = await asAdmin();
    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await app.inject({ method: 'GET', url: '/admin/auth/me', headers });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session whose account was disabled since', async () => {
    const headers = await asAdmin();
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { disabledAt: new Date() },
    });

    const response = await app.inject({ method: 'GET', url: '/admin/auth/me', headers });
    expect(response.statusCode).toBe(401);
  });

  /// Sliding, so a moderation evening is not interrupted at the half hour.
  it('pushes the expiry back on every request', async () => {
    const headers = await asAdmin();
    const before = (await prisma.adminSession.findFirstOrThrow()).expiresAt;

    await prisma.adminSession.updateMany({
      data: { expiresAt: new Date(before.getTime() - 60_000) },
    });
    await app.inject({ method: 'GET', url: '/admin/auth/me', headers });

    const after = (await prisma.adminSession.findFirstOrThrow()).expiresAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime() - 60_000);
  });

  it('closes the session on sign-out, and the token stops working', async () => {
    const headers = await asAdmin();

    const signedOut = await app.inject({
      method: 'DELETE',
      url: '/admin/auth/session',
      headers,
    });
    expect(signedOut.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/admin/auth/me', headers });
    expect(after.statusCode).toBe(401);
  });
});

/// The back office is the one place that can read everyone's data, so what it
/// does has to leave a trace — starting with who came in, and who tried.
describe('the audit log', () => {
  it('records a successful sign-in against its account', async () => {
    await signIn(credentials());

    const entries = await prisma.adminAuditEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('login.success');
    expect(entries[0].adminId).toBe(admin.id);
  });

  it('records a failure, and what kind it was', async () => {
    await signIn(credentials({ password: 'non' }));

    const entry = await prisma.adminAuditEntry.findFirstOrThrow();
    expect(entry.action).toBe('login.failure');
    expect(entry.adminId).toBe(admin.id);
    expect(JSON.parse(entry.details ?? '{}')).toMatchObject({ password: 'bad', totp: 'ok' });
  });

  /// Nobody to attach it to, and it is the line that matters most: someone is
  /// guessing at logins.
  it('records an attempt on an unknown login with no account attached', async () => {
    await signIn(credentials({ login: 'personne' }));

    const entry = await prisma.adminAuditEntry.findFirstOrThrow();
    expect(entry.action).toBe('login.failure');
    expect(entry.adminId).toBeNull();
    expect(JSON.parse(entry.details ?? '{}')).toMatchObject({ reason: 'unknown-login' });
  });

  it('records a sign-out', async () => {
    const token = (await signIn(credentials())).json().token;
    await app.inject({
      method: 'DELETE',
      url: '/admin/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(await auditActions()).toEqual(['login.success', 'logout']);
  });

  /// No secret ever reaches this table. The suite reads every line it can
  /// produce and looks for the two things that must never be in one.
  it('never writes a password or a code', async () => {
    await signIn(credentials());
    await signIn(credentials({ password: admin.password, totp: '000000' }));
    await signIn(credentials({ login: 'personne' }));

    const entries = await prisma.adminAuditEntry.findMany();
    const written = JSON.stringify(entries);

    expect(written).not.toContain(admin.password);
    expect(written).not.toContain(admin.totpSecret);
  });
});
