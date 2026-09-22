import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/// L'app barre son premier écran sur `termsAcceptedAt`. La date doit donc
/// voyager avec chaque reponse d'authentification, et non se demander à part.
describe('conditions d’utilisation', () => {
  it('un compte neuf n’a rien accepté', async () => {
    const me = await signIn(context, 'me');

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: me.authHeader,
    });

    expect(response.json().termsAcceptedAt).toBeNull();
  });

  it('accepter se voit partout ensuite', async () => {
    const me = await signIn(context, 'me');

    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/terms',
      headers: me.authHeader,
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().termsAcceptedAt).toEqual(expect.any(String));

    const me2 = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: me.authHeader,
    });
    expect(me2.json().termsAcceptedAt).toBe(accepted.json().termsAcceptedAt);

    // Et au rafraichissement, sans quoi une app relancee redemanderait.
    const refreshed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: me.refreshToken },
    });
    expect(refreshed.json().user.termsAcceptedAt).toBe(
      accepted.json().termsAcceptedAt,
    );
  });

  it('accepter deux fois ne déplace pas la date', async () => {
    const me = await signIn(context, 'me');

    const first = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/terms',
      headers: me.authHeader,
    });

    // Une app relancee deux fois sur un reseau capricieux ne doit pas
    // repousser le moment ou le compte a dit oui.
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/terms',
      headers: me.authHeader,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().termsAcceptedAt).toBe(first.json().termsAcceptedAt);
  });

  it('personne d’anonyme n’accepte pour un autre', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/terms',
    });

    expect(response.statusCode).toBe(401);
  });
});
