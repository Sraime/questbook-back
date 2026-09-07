import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';
import { createTable, invite, joinTable } from './helpers/tables.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Tables', () => {
  it('enrols the creator as game master', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    expect(table.role).toBe('gm');
    expect(table.ownerId).toBe(gm.userId);
    expect(table.members).toHaveLength(1);
    expect(table.members[0].userId).toBe(gm.userId);
  });

  it('only lists tables the caller belongs to', async () => {
    const gm = await signIn(context, 'gm');
    const stranger = await signIn(context, 'stranger');
    await createTable(context, gm);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tables',
      headers: stranger.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tables).toEqual([]);
  });

  it('hides a table from a non-member behind a 404 rather than a 403', async () => {
    const gm = await signIn(context, 'gm');
    const stranger = await signIn(context, 'stranger');
    const table = await createTable(context, gm);

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: stranger.authHeader,
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses to let a player rename the table', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${table.id}`,
      headers: player.authHeader,
      payload: { title: 'Ma table maintenant' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('will not let the game master abandon their own table', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/tables/${table.id}/members/me`,
      headers: gm.authHeader,
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets the game master remove a player', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/tables/${table.id}/members/${player.userId}`,
      headers: gm.authHeader,
    });

    expect(response.statusCode).toBe(204);

    const tables = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tables',
      headers: player.authHeader,
    });

    expect(tables.json().tables).toEqual([]);
  });
});

describe('Invitations', () => {
  it('refuses an email that has no Questbook account', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: 'inconnu@example.com' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(context.email.sent).toHaveLength(0);
  });

  it('emails a link and notifies the invited player in the app', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: player.email },
    });

    expect(response.statusCode).toBe(201);
    expect(context.email.lastTo(player.email)?.text).toContain('/invitations/');

    const notifications = await context.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: player.authHeader,
    });

    expect(notifications.json().unreadCount).toBe(1);
    expect(notifications.json().notifications[0].type).toBe('table_invitation');
  });

  it('stores the token hashed, never the token itself', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    const row = await prisma.tableInvitation.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toHaveLength(64);
  });

  it('adds the player to the table when the emailed link is used', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    const preview = await context.app.inject({
      method: 'GET',
      url: `/invitations/${token}`,
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('text/html');
    expect(preview.body).toContain('Les Inspecteurs Chavillois');

    const accept = await context.app.inject({
      method: 'POST',
      url: `/invitations/${token}/accept`,
    });

    expect(accept.statusCode).toBe(200);

    const tables = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tables',
      headers: player.authHeader,
    });

    expect(tables.json().tables).toHaveLength(1);
    expect(tables.json().tables[0].role).toBe('player');
  });

  it('tells the game master that the invitation was accepted', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const notifications = await context.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: gm.authHeader,
    });

    const types = notifications.json().notifications.map((n: { type: string }) => n.type);
    expect(types).toContain('invitation_accepted');
  });

  it('cannot be replayed once accepted', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    await context.app.inject({ method: 'POST', url: `/invitations/${token}/accept` });
    const replay = await context.app.inject({
      method: 'POST',
      url: `/invitations/${token}/accept`,
    });

    expect(replay.statusCode).toBe(409);
    expect(replay.headers['content-type']).toContain('text/html');
  });

  it('renders a page rather than a JSON envelope for an unknown token', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/invitations/not-a-real-token',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('lets the player accept from inside the app', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await invite(context, gm, table.id, player.email);

    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: player.authHeader,
    });

    const invitation = pending.json().invitations[0];
    expect(invitation.tableTitle).toBe('Les Inspecteurs Chavillois');

    const accept = await context.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitation.id}/accept`,
      headers: player.authHeader,
    });

    expect(accept.statusCode).toBe(200);
    expect(accept.json().members).toHaveLength(2);
  });

  it('stops showing a revoked invitation to the player', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await invite(context, gm, table.id, player.email);

    const invitationId = (await prisma.tableInvitation.findFirstOrThrow()).id;

    const revoke = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/tables/${table.id}/invitations/${invitationId}`,
      headers: gm.authHeader,
    });

    expect(revoke.statusCode).toBe(204);

    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: player.authHeader,
    });

    expect(pending.json().invitations).toEqual([]);
  });

  it('refuses to invite someone who is already at the table', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: player.email },
    });

    expect(response.statusCode).toBe(409);
  });

  it('only shows pending invitations to the game master', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const outsider = await signIn(context, 'outsider');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);
    await invite(context, gm, table.id, outsider.email);

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: gm.authHeader,
    });
    const asPlayer = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: player.authHeader,
    });

    expect(asGm.json().pendingInvitations).toHaveLength(1);
    expect(asPlayer.json().pendingInvitations).toEqual([]);
  });

  it('re-invites a player who declined, rather than piling up rows', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await invite(context, gm, table.id, player.email);

    const invitationId = (await prisma.tableInvitation.findFirstOrThrow()).id;
    await context.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${invitationId}/decline`,
      headers: player.authHeader,
    });

    const token = await invite(context, gm, table.id, player.email);
    expect(await prisma.tableInvitation.count()).toBe(1);

    const accept = await context.app.inject({
      method: 'POST',
      url: `/invitations/${token}/accept`,
    });
    expect(accept.statusCode).toBe(200);
  });
});
