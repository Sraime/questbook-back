import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type SignedInUser,
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

const block = (as: SignedInUser, userId: string) =>
  context.app.inject({
    method: 'POST',
    url: '/api/v1/blocks',
    headers: as.authHeader,
    payload: { userId },
  });

const listBlocks = (as: SignedInUser) =>
  context.app.inject({
    method: 'GET',
    url: '/api/v1/blocks',
    headers: as.authHeader,
  });

const members = (tableId: string) =>
  prisma.tableMember.findMany({ where: { tableId }, select: { userId: true } });

describe('POST /api/v1/blocks', () => {
  it('leaves the table they share', async () => {
    const gm = await signIn(context, 'gm');
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');
    const table = await createTable(context, gm);
    await joinTable(context, gm, me, table.id);
    await joinTable(context, gm, other, table.id);

    const response = await block(me, other.userId);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ tablesLeft: 1, playersRemoved: 0 });
    expect((await members(table.id)).map((m) => m.userId)).toEqual(
      expect.not.arrayContaining([me.userId]),
    );
    // L'autre reste : c'est moi qui pars, pas lui qu'on chasse.
    expect((await members(table.id)).map((m) => m.userId)).toContain(
      other.userId,
    );
  });

  it('removes the other instead when the blocker runs the table', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    const response = await block(gm, player.userId);

    expect(response.json()).toMatchObject({ tablesLeft: 0, playersRemoved: 1 });

    // Le MJ ne peut pas partir : la table resterait sans personne pour y
    // organiser quoi que ce soit.
    const left = (await members(table.id)).map((m) => m.userId);
    expect(left).toEqual([gm.userId]);
  });

  it('sorts each shared table on its own', async () => {
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');

    const mine = await createTable(context, me, 'Ma table');
    await joinTable(context, me, other, mine.id);

    const theirs = await createTable(context, other, 'La sienne');
    await joinTable(context, other, me, theirs.id);

    const response = await block(me, other.userId);

    expect(response.json()).toMatchObject({ tablesLeft: 1, playersRemoved: 1 });
    expect((await members(mine.id)).map((m) => m.userId)).toEqual([me.userId]);
    expect((await members(theirs.id)).map((m) => m.userId)).toEqual([
      other.userId,
    ]);
  });

  it('refuses the invitations that follow', async () => {
    const gm = await signIn(context, 'gm');
    const me = await signIn(context, 'me');
    const table = await createTable(context, gm);

    await block(me, gm.userId);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: me.email },
    });

    expect(response.statusCode).toBe(403);
    // Le message ne dit pas pourquoi : apprendre qu'on a été bloqué est ce
    // que le geste évite, et une invitation sonderait sinon tout un carnet.
    expect(response.json().error.message).not.toMatch(/bloqu/i);
  });

  it('drops the invitation already waiting', async () => {
    const gm = await signIn(context, 'gm');
    const me = await signIn(context, 'me');
    const table = await createTable(context, gm);
    await invite(context, gm, table.id, me.email);

    expect(await prisma.tableInvitation.count()).toBe(1);

    await block(me, gm.userId);

    expect(await prisma.tableInvitation.count()).toBe(0);
  });

  it('leaves other people’s invitations alone', async () => {
    const gm = await signIn(context, 'gm');
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');
    const table = await createTable(context, gm);
    await invite(context, gm, table.id, other.email);

    await block(me, gm.userId);

    expect(await prisma.tableInvitation.count()).toBe(1);
  });

  it('can be repeated without complaining', async () => {
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');

    expect((await block(me, other.userId)).statusCode).toBe(201);
    expect((await block(me, other.userId)).statusCode).toBe(201);
    expect(await prisma.userBlock.count()).toBe(1);
  });

  it('undoes what a rejoined table brought back', async () => {
    const gm = await signIn(context, 'gm');
    const me = await signIn(context, 'me');
    const table = await createTable(context, gm);
    await joinTable(context, gm, me, table.id);

    await block(me, gm.userId);
    // Rejoindre après coup : le blocage tient toujours, mais la table s'est
    // refaite. Le rejouer doit la défaire à nouveau.
    await prisma.tableMember.create({
      data: { tableId: table.id, userId: me.userId, role: 'player' },
    });

    const again = await block(me, gm.userId);

    expect(again.json()).toMatchObject({ tablesLeft: 1 });
    expect((await members(table.id)).map((m) => m.userId)).toEqual([gm.userId]);
  });

  it('refuses to block oneself, and an unknown account', async () => {
    const me = await signIn(context, 'me');

    expect((await block(me, me.userId)).statusCode).toBe(400);
    expect(
      (await block(me, '00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('is one-way: the blocked one can still invite others', async () => {
    const gm = await signIn(context, 'gm');
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');
    const table = await createTable(context, gm);

    await block(me, gm.userId);

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/invitations`,
      headers: gm.authHeader,
      payload: { email: other.email },
    });

    expect(response.statusCode).toBe(201);
  });
});

describe('GET et DELETE /api/v1/blocks', () => {
  it('lists who is blocked, and lets them back', async () => {
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');
    await prisma.user.update({
      where: { id: other.userId },
      data: { displayName: 'Hélène' },
    });

    await block(me, other.userId);

    const listed = await listBlocks(me);
    expect(listed.json().blocks).toHaveLength(1);
    expect(listed.json().blocks[0]).toMatchObject({
      userId: other.userId,
      displayName: 'Hélène',
    });

    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/blocks/${other.userId}`,
      headers: me.authHeader,
    });

    expect(removed.statusCode).toBe(204);
    expect((await listBlocks(me)).json().blocks).toEqual([]);
  });

  it('shows nothing to the one who was blocked', async () => {
    const me = await signIn(context, 'me');
    const other = await signIn(context, 'other');

    await block(me, other.userId);

    expect((await listBlocks(other)).json().blocks).toEqual([]);
  });

  it('turns an anonymous caller away', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/blocks',
    });

    expect(response.statusCode).toBe(401);
  });
});
