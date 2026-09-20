import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';

describe('Google authentication', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await context.app.close();
    await prisma.$disconnect();
  });

  beforeEach(resetDatabase);

  it('creates an account on the first sign-in and reuses it afterwards', async () => {
    const first = await signIn(context, 'sub-alice');
    const second = await signIn(context, 'sub-alice');

    expect(second.userId).toBe(first.userId);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects an ID token Google does not recognise', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'forged' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('takes the display name from Google once, and never again', async () => {
    context.google.register('id-token-sub-bob', {
      sub: 'sub-bob',
      displayName: 'Bob',
    });
    const first = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'id-token-sub-bob' },
    });
    expect(first.json().user.displayName).toBe('Bob');

    context.google.register('id-token-sub-bob', {
      sub: 'sub-bob',
      displayName: 'Bob Renamed',
    });
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'id-token-sub-bob' },
    });

    // Sinon un pseudo choisi dans Questbook serait efface a la connexion
    // suivante, sans que personne ne comprenne pourquoi.
    expect(second.json().user.displayName).toBe('Bob');
  });

  it('renames the account, and the new name survives a sign-in', async () => {
    const user = await signIn(context, 'sub-carol');

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: user.authHeader,
      payload: { displayName: '  Le Gardien  ' },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().displayName).toBe('Le Gardien');

    const again = await signIn(context, 'sub-carol');
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: again.authHeader,
    });
    expect(me.json().displayName).toBe('Le Gardien');
  });

  it('refuses an empty pseudonym and an anonymous rename', async () => {
    const user = await signIn(context);

    const empty = await context.app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: user.authHeader,
      payload: { displayName: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const anonymous = await context.app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      payload: { displayName: 'Personne' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('returns the current user on /me and refuses anonymous callers', async () => {
    const user = await signIn(context);

    const authenticated = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: user.authHeader,
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().id).toBe(user.userId);

    const anonymous = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('rotates the refresh token and refuses to replay the used one', async () => {
    const user = await signIn(context);

    const refreshed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).not.toBe(user.refreshToken);

    const replayed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(replayed.statusCode).toBe(401);
  });

  it('kills the session on logout', async () => {
    const user = await signIn(context);

    const loggedOut = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: user.refreshToken },
    });
    expect(loggedOut.statusCode).toBe(204);

    const afterLogout = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('never stores a refresh token in clear text', async () => {
    const user = await signIn(context);

    const stored = await prisma.refreshToken.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(user.refreshToken);
    expect(stored[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
