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

/// Deux joueurs, et non un : tout l'interet des indices est qu'ils ne vont pas
/// a tout le monde, ce qu'une table a un seul joueur ne peut pas montrer.
async function tableWithSession() {
  const gm = await signIn(context, 'gm');
  const alice = await signIn(context, 'alice');
  const bob = await signIn(context, 'bob');
  const table = await createTable(context, gm);
  await joinTable(context, gm, alice, table.id);
  await joinTable(context, gm, bob, table.id);

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

  return {
    gm,
    alice,
    bob,
    tableId: table.id as string,
    sessionId: session.json().id as string,
  };
}

const addClue = (
  as: SignedInUser,
  sessionId: string,
  payload: Record<string, unknown>,
) =>
  context.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/clues`,
    headers: as.authHeader,
    payload,
  });

const listClues = (as: SignedInUser, sessionId: string) =>
  context.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${sessionId}/clues`,
    headers: as.authHeader,
  });

const myClues = (as: SignedInUser, sessionId: string) =>
  context.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${sessionId}/clues/mine`,
    headers: as.authHeader,
  });

const shareWith = (
  as: SignedInUser,
  sessionId: string,
  clueId: string,
  userIds: string[],
) =>
  context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/clues/${clueId}/access`,
    headers: as.authHeader,
    payload: { userIds },
  });

describe('clues', () => {
  it('composes one, reads it back, then deletes it', async () => {
    const { gm, sessionId } = await tableWithSession();

    const created = await addClue(gm, sessionId, {
      title: 'La lettre de Corbitt',
      contentMarkdown: '## Mon ami\n\nNe descends pas à la cave.',
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      title: 'La lettre de Corbitt',
      kind: 'markdown',
      sessionId,
      sharedWith: [],
    });

    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}/clues/${created.json().id}`,
      headers: gm.authHeader,
      payload: { contentMarkdown: '## Mon ami\n\nDescends, finalement.' },
    });
    expect(patched.json().contentMarkdown).toContain('finalement');

    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}/clues/${created.json().id}`,
      headers: gm.authHeader,
    });
    expect(removed.statusCode).toBe(204);
    expect((await listClues(gm, sessionId)).json().clues).toHaveLength(0);
  });

  /// L'etat de repos, et celui qu'on risque de casser en croyant bien faire.
  it('belongs to nobody until the game master says otherwise', async () => {
    const { gm, alice, sessionId } = await tableWithSession();

    await addClue(gm, sessionId, { title: 'La lettre', contentMarkdown: 'Secret' });

    expect((await myClues(alice, sessionId)).json().clues).toEqual([]);
  });

  it('reaches the named player, and only them', async () => {
    const { gm, alice, bob, sessionId } = await tableWithSession();

    const clue = await addClue(gm, sessionId, {
      title: 'La lettre',
      contentMarkdown: 'Ne descends pas.',
    });

    const shared = await shareWith(gm, sessionId, clue.json().id, [alice.userId]);
    expect(shared.json().sharedWith).toEqual([alice.userId]);

    const hers = (await myClues(alice, sessionId)).json().clues;
    expect(hers).toHaveLength(1);
    expect(hers[0]).toMatchObject({ title: 'La lettre', contentMarkdown: 'Ne descends pas.' });

    expect((await myClues(bob, sessionId)).json().clues).toEqual([]);
  });

  /// Ce que le MJ garde ne doit pas se deviner : ni par un compte, ni par un
  /// identifiant, ni par un trou dans un ordre.
  it('tells a player nothing about the clues they were not given', async () => {
    const { gm, alice, sessionId } = await tableWithSession();

    const sienne = await addClue(gm, sessionId, { title: 'Pour elle', contentMarkdown: 'A' });
    await addClue(gm, sessionId, { title: 'Pas pour elle', contentMarkdown: 'B' });
    await addClue(gm, sessionId, { title: 'Pas pour elle non plus', contentMarkdown: 'C' });
    await shareWith(gm, sessionId, sienne.json().id, [alice.userId]);

    const reponse = await myClues(alice, sessionId);

    expect(reponse.json().clues).toHaveLength(1);
    expect(reponse.body).not.toContain('Pas pour elle');
    // Aucun decompte, et surtout pas la liste des destinataires du MJ.
    expect(reponse.json()).not.toHaveProperty('total');
    expect(reponse.json().clues[0]).not.toHaveProperty('sharedWith');
  });

  it('takes a clue back with the same call, one name fewer', async () => {
    const { gm, alice, bob, sessionId } = await tableWithSession();

    const clue = await addClue(gm, sessionId, { title: 'La lettre', contentMarkdown: 'X' });
    await shareWith(gm, sessionId, clue.json().id, [alice.userId, bob.userId]);
    expect((await myClues(bob, sessionId)).json().clues).toHaveLength(1);

    const repris = await shareWith(gm, sessionId, clue.json().id, [alice.userId]);

    expect(repris.json().sharedWith).toEqual([alice.userId]);
    expect((await myClues(bob, sessionId)).json().clues).toEqual([]);
    expect((await myClues(alice, sessionId)).json().clues).toHaveLength(1);
  });

  it('accepts an empty list, which is how a clue goes back to nobody', async () => {
    const { gm, alice, sessionId } = await tableWithSession();

    const clue = await addClue(gm, sessionId, { title: 'La lettre', contentMarkdown: 'X' });
    await shareWith(gm, sessionId, clue.json().id, [alice.userId]);

    const repris = await shareWith(gm, sessionId, clue.json().id, []);

    expect(repris.statusCode).toBe(200);
    expect(repris.json().sharedWith).toEqual([]);
    expect((await myClues(alice, sessionId)).json().clues).toEqual([]);
  });

  it('refuses a recipient who is not at the table', async () => {
    const { gm, sessionId } = await tableWithSession();
    const etranger = await signIn(context, 'etranger');

    const clue = await addClue(gm, sessionId, { title: 'La lettre', contentMarkdown: 'X' });
    const refus = await shareWith(gm, sessionId, clue.json().id, [etranger.userId]);

    expect(refus.statusCode).toBe(400);
    expect((await listClues(gm, sessionId)).json().clues[0].sharedWith).toEqual([]);
  });

  describe('who may do what', () => {
    it('keeps composing to the game master', async () => {
      const { gm, alice, sessionId } = await tableWithSession();

      expect((await addClue(alice, sessionId, { title: 'A moi' })).statusCode).toBe(403);
      expect((await listClues(alice, sessionId)).statusCode).toBe(403);

      const clue = await addClue(gm, sessionId, { title: 'La lettre' });
      expect((await shareWith(alice, sessionId, clue.json().id, [alice.userId])).statusCode).toBe(
        403,
      );
    });

    it('hides a session the caller has nothing to do with', async () => {
      const { sessionId } = await tableWithSession();
      const etranger = await signIn(context, 'etranger');

      // 404 et non 403 : un appelant ne doit pas pouvoir sonder les ids.
      expect((await myClues(etranger, sessionId)).statusCode).toBe(404);
      expect((await listClues(etranger, sessionId)).statusCode).toBe(404);
    });

    it('refuses a clue reached through another session', async () => {
      const { gm, sessionId, tableId } = await tableWithSession();
      const clue = await addClue(gm, sessionId, { title: 'La lettre' });

      const autre = await context.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${tableId}/sessions`,
        headers: gm.authHeader,
        payload: {
          title: 'Une autre soirée',
          startsAt: '2026-11-12T19:00:00.000Z',
          location: 'Chez Robin',
        },
      });

      const perdu = await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${autre.json().id}/clues/${clue.json().id}`,
        headers: gm.authHeader,
      });

      expect(perdu.statusCode).toBe(404);
    });
  });

  describe('what the cascades must do', () => {
    it('drops the permissions of a player who leaves the table', async () => {
      const { gm, alice, sessionId, tableId } = await tableWithSession();

      const clue = await addClue(gm, sessionId, { title: 'La lettre', contentMarkdown: 'X' });
      await shareWith(gm, sessionId, clue.json().id, [alice.userId]);

      const retiree = await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/tables/${tableId}/members/${alice.userId}`,
        headers: gm.authHeader,
      });
      expect(retiree.statusCode).toBe(204);

      expect(
        await prisma.sessionClueAccess.count({ where: { userId: alice.userId } }),
      ).toBe(0);
      expect((await listClues(gm, sessionId)).json().clues[0].sharedWith).toEqual([]);
    });

    it('leaves no permission behind when the clue goes', async () => {
      const { gm, alice, sessionId } = await tableWithSession();

      const clue = await addClue(gm, sessionId, { title: 'La lettre', contentMarkdown: 'X' });
      await shareWith(gm, sessionId, clue.json().id, [alice.userId]);

      await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${sessionId}/clues/${clue.json().id}`,
        headers: gm.authHeader,
      });

      expect(await prisma.sessionClueAccess.count()).toBe(0);
    });
  });
});
