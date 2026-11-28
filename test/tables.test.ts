import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';
import { createTable, invite, joinTable, redeem } from './helpers/tables.js';

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
  it('emails an unknown address a link that says it only works once', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: 'inconnu@example.com' },
    });

    expect(response.statusCode).toBe(201);
    const sent = context.email.lastTo('inconnu@example.com');
    expect(sent?.text).toContain('/invitations/');
    expect(sent?.text).toContain('ne sert qu’une fois');
    expect(sent?.html).toContain('ne sert qu\'une fois');
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

  /// Ces textes ont dit « Google » pendant toute la vie de la connexion
  /// Google, et sont restes faux le jour ou Apple a ouvert une seconde porte.
  /// Rien ne les couvrait, d'ou ce qui suit : ce n'est pas la formulation
  /// qu'on verrouille, c'est l'absence de fournisseur.
  describe('what the invitation tells an address', () => {
    it('names no provider, for a mailbox that has no account yet', async () => {
      const gm = await signIn(context, 'gm');
      const table = await createTable(context, gm);

      await context.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${table.id}/invitations`,
        headers: gm.authHeader,
        payload: { email: 'inconnu@example.com' },
      });

      const sent = context.email.lastTo('inconnu@example.com');

      expect(sent?.text).not.toMatch(/Google|Apple/);
      expect(sent?.html).not.toMatch(/Google|Apple/);

      // L'adresse ne compte plus : le message ne doit plus demander de se
      // connecter avec elle, ce qui egarerait un compte Apple.
      expect(sent?.text).not.toContain('cette adresse');
      expect(sent?.html).not.toContain('cette adresse');
    });

    it('names no provider either when the account already exists', async () => {
      const gm = await signIn(context, 'gm');
      const player = await signIn(context, 'player');
      const table = await createTable(context, gm);

      await context.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${table.id}/invitations`,
        headers: gm.authHeader,
        payload: { email: player.email },
      });

      expect(context.email.lastTo(player.email)?.text).not.toMatch(/Google|Apple/);
      expect(context.email.lastTo(player.email)?.html).not.toMatch(/Google|Apple/);
    });

    it('names no provider on the page the link opens', async () => {
      const gm = await signIn(context, 'gm');
      const table = await createTable(context, gm);

      const token = await invite(context, gm, table.id, 'inconnu@example.com');

      const page = await context.app.inject({ method: 'GET', url: `/invitations/${token}` });

      expect(page.statusCode).toBe(200);
      // `Google Play` et `App Store` sont des stores, pas des fournisseurs de
      // connexion : seul le second sens est interdit.
      expect(page.body).not.toMatch(/compte (Google|Apple)/);
    });
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

  it('adds the player to the table when the app redeems the code', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    // La page s'affiche sans rien consommer : un client mail qui precharge
    // les liens ne doit pas bruler le code.
    const preview = await context.app.inject({
      method: 'GET',
      url: `/invitations/${token}`,
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('text/html');
    expect(preview.body).toContain('Les Inspecteurs Chavillois');

    const joined = await redeem(context, player, token);

    expect(joined.statusCode).toBe(200);
    expect(joined.json().id).toBe(table.id);
    expect(joined.json().role).toBe('player');
  });

  it('lets an account whose address is not the invited one join', async () => {
    // Le cas qui a motive le code : un compte Apple, dont l'adresse est un
    // relais que le MJ n'a jamais vu.
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, 'ami@example.com');

    context.apple.register('apple-ami', { sub: '000123.ami', email: null });
    const apple = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/apple',
      payload: { identityToken: 'apple-ami' },
    });
    const friend = {
      userId: apple.json().user.id as string,
      email: '',
      authHeader: { authorization: `Bearer ${apple.json().accessToken}` },
    };

    const joined = await redeem(context, friend, token);

    expect(joined.statusCode).toBe(200);
    const row = await prisma.tableInvitation.findFirstOrThrow();
    expect(row.status).toBe('accepted');
    expect(row.invitedUserId).toBe(friend.userId);
  });

  it('takes the invitation away from the address once someone else used the code', async () => {
    const gm = await signIn(context, 'gm');
    const addressee = await signIn(context, 'addressee');
    const other = await signIn(context, 'other');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, addressee.email);

    await redeem(context, other, token);

    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: addressee.authHeader,
    });
    expect(pending.json().invitations).toEqual([]);
  });

  it('refuses to redeem a code without being signed in', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, 'inconnu@example.com');

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/redeem',
      payload: { code: token },
    });

    expect(response.statusCode).toBe(401);
  });

  it('no longer accepts anything from the web page', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    const response = await context.app.inject({
      method: 'POST',
      url: `/invitations/${token}/accept`,
    });

    expect(response.statusCode).toBe(404);
    expect((await prisma.tableInvitation.findFirstOrThrow()).status).toBe('pending');
  });

  it('refuses an expired code', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);
    await prisma.tableInvitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await redeem(context, player, token);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe('Cette invitation a expiré.');
  });

  it('refuses a code the game master revoked', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);
    await prisma.tableInvitation.updateMany({ data: { status: 'revoked' } });

    const response = await redeem(context, player, token);

    expect(response.statusCode).toBe(409);
  });

  it('keeps the code for its addressee when a member opens it', async () => {
    // Le MJ qui teste son propre lien ne doit pas le gacher.
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    const mine = await redeem(context, gm, token);
    expect(mine.statusCode).toBe(409);
    expect(mine.json().error.message).toBe('Tu fais déjà partie de cette table.');

    expect((await redeem(context, player, token)).statusCode).toBe(200);
  });

  describe('blocks', () => {
    const block = (by: { authHeader: Record<string, string> }, userId: string) =>
      context.app.inject({
        method: 'POST',
        url: '/api/v1/blocks',
        headers: by.authHeader,
        payload: { userId },
      });

    it('keeps out someone who blocked the game master', async () => {
      const gm = await signIn(context, 'gm');
      const player = await signIn(context, 'player');
      const table = await createTable(context, gm);
      const token = await invite(context, gm, table.id, 'autre@example.com');
      await block(player, gm.userId);

      const response = await redeem(context, player, token);

      expect(response.statusCode).toBe(403);
      expect((await prisma.tableInvitation.findFirstOrThrow()).status).toBe('pending');
    });

    it('keeps out someone a player of the table blocked', async () => {
      const gm = await signIn(context, 'gm');
      const seated = await signIn(context, 'seated');
      const intruder = await signIn(context, 'intruder');
      const table = await createTable(context, gm);
      await joinTable(context, gm, seated, table.id);
      const token = await invite(context, gm, table.id, 'autre@example.com');
      await block(seated, intruder.userId);

      const response = await redeem(context, intruder, token);

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).not.toMatch(/bloqu/i);
    });
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

  it('cannot be spent by a second account once used', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const thief = await signIn(context, 'thief');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    await redeem(context, player, token);
    const replay = await redeem(context, thief, token);

    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.message).toBe('Cette invitation a déjà été utilisée.');

    const tables = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tables',
      headers: thief.authHeader,
    });
    expect(tables.json().tables).toEqual([]);
  });

  it('lets only one of two simultaneous accounts in', async () => {
    const gm = await signIn(context, 'gm');
    const first = await signIn(context, 'first');
    const second = await signIn(context, 'second');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, 'autre@example.com');

    const answers = await Promise.all([
      redeem(context, first, token),
      redeem(context, second, token),
    ]);

    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.tableMember.count({ where: { role: 'player' } })).toBe(1);
  });

  it('answers the same account opening its link again with the table', async () => {
    // Une requete rejouee apres une coupure reseau, ou un second clic.
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);

    await redeem(context, player, token);
    const again = await redeem(context, player, token);

    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(table.id);
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

    const accept = await redeem(context, player, token);
    expect(accept.statusCode).toBe(200);
  });

  it('attaches a pending invitation once the mailbox creates an account', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);
    await invite(context, gm, table.id, 'nouveau@example.com');

    context.google.register('id-token-nouveau', {
      sub: 'nouveau',
      email: 'nouveau@example.com',
    });
    const signedIn = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      payload: { idToken: 'id-token-nouveau' },
    });
    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/v1/invitations',
      headers: { authorization: `Bearer ${signedIn.json().accessToken}` },
    });

    expect(pending.json().invitations).toHaveLength(1);
    expect(pending.json().invitations[0].email).toBe('nouveau@example.com');
  });

  it('refuses a ninth player at a table', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    for (let i = 0; i < 8; i += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${table.id}/invitations`,
        headers: gm.authHeader,
        payload: { email: `joueur${i}@example.com` },
      });
      expect(response.statusCode).toBe(201);
    }

    const ninth = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: 'en-trop@example.com' },
    });

    expect(ninth.statusCode).toBe(409);
    expect(ninth.json().error.code).toBe('CONFLICT');
  });

  it('caps invitations at 15 per game master per day', async () => {
    const gm = await signIn(context, 'gm');

    for (let i = 0; i < 15; i += 1) {
      const table = await createTable(context, gm, `Table ${i}`);
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${table.id}/invitations`,
        headers: gm.authHeader,
        payload: { email: `quota${i}@example.com` },
      });
      expect(response.statusCode).toBe(201);
    }

    const extraTable = await createTable(context, gm, 'Table 15');
    const sixteenth = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${extraTable.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: 'quota15@example.com' },
    });

    expect(sixteenth.statusCode).toBe(429);
    expect(sixteenth.json().error.code).toBe('TOO_MANY_REQUESTS');
  });
});
