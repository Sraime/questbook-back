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

async function tableWithSession() {
  const gm = await signIn(context, 'gm');
  const player = await signIn(context, 'player');
  const table = await createTable(context, gm);
  await joinTable(context, gm, player, table.id);

  const session = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${table.id}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Le manoir Corbitt',
      startsAt: '2026-10-12T19:00:00.000Z',
      location: 'Chez Robin',
    },
  });
  expect(session.statusCode).toBe(201);

  return { gm, player, tableId: table.id as string, sessionId: session.json().id as string };
}

const addNpc = (
  as: SignedInUser,
  sessionId: string,
  payload: Record<string, unknown>,
) =>
  context.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/npcs`,
    headers: as.authHeader,
    payload,
  });

const listNpcs = (as: SignedInUser, sessionId: string) =>
  context.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${sessionId}/npcs`,
    headers: as.authHeader,
  });

describe('non-player characters', () => {
  it('adds one, lists it, then removes it', async () => {
    const { gm, sessionId } = await tableWithSession();

    const created = await addNpc(gm, sessionId, {
      name: 'Le rôdeur du seuil',
      description: 'Ne parle qu’à ceux qui ont déjà vu le livre.',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Le rôdeur du seuil',
      description: 'Ne parle qu’à ceux qui ont déjà vu le livre.',
      sessionId,
    });

    const listed = await listNpcs(gm, sessionId);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().npcs).toHaveLength(1);

    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}/npcs/${created.json().id}`,
      headers: gm.authHeader,
    });
    expect(removed.statusCode).toBe(204);
    expect((await listNpcs(gm, sessionId)).json().npcs).toEqual([]);
  });

  it('accepts a bare name and corrects it afterwards', async () => {
    const { gm, sessionId } = await tableWithSession();

    // On note d'abord le nom qui vient a l'esprit, on decrit ensuite.
    const created = await addNpc(gm, sessionId, { name: 'Créature' });
    expect(created.statusCode).toBe(201);
    expect(created.json().description).toBe('');

    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}/npcs/${created.json().id}`,
      headers: gm.authHeader,
      payload: { description: 'Rampe au plafond de la cave.' },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: 'Créature',
      description: 'Rampe au plafond de la cave.',
    });
  });

  it('hides them from the players of the very same session', async () => {
    const { gm, player, sessionId } = await tableWithSession();
    await addNpc(gm, sessionId, { name: 'Le rôdeur du seuil' });

    // Le coeur de la carte : ce que le MJ prepare est exactement ce que les
    // joueurs ne doivent pas savoir.
    const listed = await listNpcs(player, sessionId);
    expect(listed.statusCode).toBe(403);

    const added = await addNpc(player, sessionId, { name: 'Mon allié' });
    expect(added.statusCode).toBe(403);

    const session = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
      headers: player.authHeader,
    });
    expect(session.statusCode).toBe(200);
    expect(JSON.stringify(session.json())).not.toContain('rôdeur');
  });

  it('answers 404 to a stranger rather than admitting the session exists',
    async () => {
      const { sessionId } = await tableWithSession();
      const stranger = await signIn(context, 'stranger');

      expect((await listNpcs(stranger, sessionId)).statusCode).toBe(404);
    });

  it('refuses to reach into another session through one it runs', async () => {
    const first = await tableWithSession();
    const created = await addNpc(first.gm, first.sessionId, { name: 'Le rôdeur' });

    const second = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${first.tableId}/sessions`,
      headers: first.gm.authHeader,
      payload: {
        title: 'La seconde veillée',
        startsAt: '2026-10-19T19:00:00.000Z',
        location: 'Chez Robin',
      },
    });

    const crossed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${second.json().id}/npcs/${created.json().id}`,
      headers: first.gm.authHeader,
    });

    expect(crossed.statusCode).toBe(404);
    expect((await listNpcs(first.gm, first.sessionId)).json().npcs).toHaveLength(1);
  });

  it('refuses a nameless one', async () => {
    const { gm, sessionId } = await tableWithSession();

    const created = await addNpc(gm, sessionId, { name: '   ' });
    expect(created.statusCode).toBe(400);
  });

  it('disappears with the session that held it', async () => {
    const { gm, tableId, sessionId } = await tableWithSession();
    await addNpc(gm, sessionId, { name: 'Le rôdeur du seuil' });

    await prisma.gameTable.delete({ where: { id: tableId } });

    expect(await prisma.sessionNpc.count()).toBe(0);
  });
});
