import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type SignedInUser,
  type TestContext,
} from './helpers/test-app.js';
import { createTable, joinTable } from './helpers/tables.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function jwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) {
    throw new Error('access token is not a JWT');
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('personal data minimisation', () => {
  it('keeps the access token free of an email address', async () => {
    const user = await signIn(context, 'alice');
    const payload = jwtPayload(user.accessToken);

    expect(payload.sub).toBe(user.userId);
    expect(payload).not.toHaveProperty('email');
  });

  it('shows a member their own email and never anybody else\'s', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: gm.authHeader,
    });
    const gmView = asGm.json();
    const gmSelf = gmView.members.find(
      (member: { userId: string }) => member.userId === gm.userId,
    );
    const gmOther = gmView.members.find(
      (member: { userId: string }) => member.userId === player.userId,
    );

    expect(gmSelf.user.email).toBe(gm.email);
    expect(gmOther.user.email).toBeUndefined();
    expect(JSON.stringify(gmView)).not.toContain(player.email);

    const asPlayer = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: player.authHeader,
    });
    const playerView = asPlayer.json();
    const playerSelf = playerView.members.find(
      (member: { userId: string }) => member.userId === player.userId,
    );
    const playerOther = playerView.members.find(
      (member: { userId: string }) => member.userId === gm.userId,
    );

    expect(playerSelf.user.email).toBe(player.email);
    expect(playerOther.user.email).toBeUndefined();
    expect(JSON.stringify(playerView)).not.toContain(gm.email);
  });

  it('labels a nameless player as Joueur instead of their mailbox', async () => {
    const gm = await signIn(context, 'gm');
    context.google.register('id-token-anon', {
      sub: 'anon',
      displayName: null,
      email: 'secret.mailbox@example.com',
    });
    const signedIn = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'id-token-anon' },
    });
    const body = signedIn.json();
    const player: SignedInUser = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      userId: body.user.id,
      email: body.user.email,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };

    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: gm.authHeader,
    });
    const other = asGm
      .json()
      .members.find((member: { userId: string }) => member.userId === player.userId);

    expect(other.user.displayName).toBe('Joueur');
    expect(other.user.email).toBeUndefined();
    expect(JSON.stringify(asGm.json())).not.toContain(player.email);
  });

  it('does not echo an invitation token in a 404 body', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/invitations/supersecrettoken123',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('supersecrettoken123');
  });
});
