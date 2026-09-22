import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';

describe('Apple authentication', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await context.app.close();
    await prisma.$disconnect();
  });

  beforeEach(resetDatabase);

  const signInWithApple = (identityToken: string, displayName?: string) =>
    context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      payload: { identityToken, ...(displayName ? { displayName } : {}) },
    });

  it('creates an account on the first sign-in and reuses it afterwards', async () => {
    context.apple.register('apple-token', { sub: '000123.abc.0001' });

    const first = await signInWithApple('apple-token');
    expect(first.statusCode).toBe(200);
    expect(first.json().user.termsAcceptedAt).toBeNull();

    const second = await signInWithApple('apple-token');
    expect(second.json().user.id).toBe(first.json().user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it('stores the Apple subject and leaves the Google one empty', async () => {
    context.apple.register('apple-token', { sub: '000123.abc.0002' });
    await signInWithApple('apple-token');

    const user = await prisma.user.findFirstOrThrow();
    expect(user.appleSub).toBe('000123.abc.0002');
    expect(user.googleSub).toBeNull();
  });

  it('rejects an identity token Apple does not recognise', async () => {
    const response = await signInWithApple('forged');

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('takes the display name from the client once, and never again', async () => {
    // Apple ne met pas le nom dans le jeton et ne le remet jamais : c'est le
    // client qui le passe, a la premiere autorisation.
    context.apple.register('apple-token', { sub: '000123.abc.0003' });

    const first = await signInWithApple('apple-token', '  Le Gardien  ');
    expect(first.json().user.displayName).toBe('Le Gardien');

    const second = await signInWithApple('apple-token', 'Renomme De Force');
    expect(second.json().user.displayName).toBe('Le Gardien');
  });

  it('accepts an account that shared no name at all', async () => {
    context.apple.register('apple-token', { sub: '000123.abc.0004' });

    const response = await signInWithApple('apple-token');
    expect(response.statusCode).toBe(200);
    expect(response.json().user.displayName).toBeNull();
  });

  it('refuses to create an account with no email address', async () => {
    // Une table s'invite par adresse : sans elle il n'y a pas de compte a
    // creer, et le dire vaut mieux qu'en fabriquer une.
    context.apple.register('apple-token', { sub: '000123.abc.0005', email: null });

    const response = await signInWithApple('apple-token');
    expect(response.statusCode).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses an unverified email', async () => {
    context.apple.register('apple-token', {
      sub: '000123.abc.0006',
      email: 'douteux@example.com',
      emailVerified: false,
    });

    const response = await signInWithApple('apple-token');
    expect(response.statusCode).toBe(401);
  });

  it('names the collision when the address already signs in with Google', async () => {
    const google = await signIn(context, 'sub-deja-la');
    context.apple.register('apple-token', {
      sub: '000123.abc.0007',
      email: google.email,
    });

    const response = await signInWithApple('apple-token');

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('Google');
    expect(await prisma.user.count()).toBe(1);
  });

  it('grants the starter scenarios, like a Google sign-in does', async () => {
    const starter = await prisma.scenario.create({
      data: {
        title: 'Le Phare de Kerloch',
        description: 'Une nuit de tempete.',
        context: "Kerloc'h, 1924.",
        minRecommendedPlayers: 2,
        maxRecommendedPlayers: 5,
        averageDurationMinutes: 180,
        rundownMarkdown: '## Mise en place',
        grantOnSignup: true,
      },
    });

    context.apple.register('apple-token', { sub: '000123.abc.0008' });
    const response = await signInWithApple('apple-token');

    const owned = await prisma.scenarioOwnership.findMany({
      where: { userId: response.json().user.id },
    });
    expect(owned.map((row) => row.scenarioId)).toEqual([starter.id]);
  });

  it('issues a session that works on the rest of the API', async () => {
    context.apple.register('apple-token', { sub: '000123.abc.0009' });
    const signed = await signInWithApple('apple-token');

    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${signed.json().accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(signed.json().user.id);
  });

  it('refuses a request without an identity token', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
