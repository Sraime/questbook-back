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

const hour = 60 * 60 * 1000;

async function tableWithPlayer() {
  const gm = await signIn(context, 'gm');
  const player = await signIn(context, 'player');
  const table = await createTable(context, gm);
  await joinTable(context, gm, player, table.id);
  return { gm, player, tableId: table.id as string };
}

/// `startsAt` relatif à maintenant, et `createdAt` posé à la main : la règle
/// se lit sur deux instants, et les tests doivent pouvoir placer les deux.
async function scheduleSession(
  gm: SignedInUser,
  tableId: string,
  { startsInMs, createdAgoMs = 0 }: { startsInMs: number; createdAgoMs?: number },
) {
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${tableId}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Le manoir Corbitt',
      startsAt: new Date(Date.now() + startsInMs).toISOString(),
      location: 'Chez Robin',
    },
  });

  expect(response.statusCode).toBe(201);
  const session = response.json();

  if (createdAgoMs > 0) {
    await prisma.gameSession.update({
      where: { id: session.id },
      data: { createdAt: new Date(Date.now() - createdAgoMs) },
    });
  }

  return session;
}

async function answer(as: SignedInUser, sessionId: string, status: string) {
  return context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/attendance`,
    headers: as.authHeader,
    payload: { status },
  });
}

async function readTable(as: SignedInUser, tableId: string) {
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/v1/tables/${tableId}`,
    headers: as.authHeader,
  });

  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('Les bornes d’une séance', () => {
  it('annonce les deux instants qui la bornent', async () => {
    const { gm, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId, { startsInMs: 48 * hour });

    const startsAt = new Date(session.startsAt).getTime();

    expect(new Date(session.closesAt).getTime()).toBe(startsAt + 24 * hour);
    // Début dans deux jours : le délai d'une heure après la création n'entre
    // pas en jeu, les inscriptions ferment au début.
    expect(new Date(session.answersCloseAt).getTime()).toBe(startsAt);
  });

  it('laisse une heure aux joueurs quand la séance est proposée pour tout de suite',
    async () => {
      const { gm, tableId } = await tableWithPlayer();
      // « Il est 18h, on joue à 18h30 ? »
      const session = await scheduleSession(gm, tableId, { startsInMs: 30 * 60 * 1000 });

      const createdAt = new Date(session.createdAt).getTime();

      expect(new Date(session.answersCloseAt).getTime()).toBe(createdAt + hour);
    });
});

describe('Pendant et après la partie', () => {
  it('reste la prochaine séance de sa table une fois commencée', async () => {
    const { gm, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId, { startsInMs: -2 * hour });

    expect((await readTable(gm, tableId)).nextSessionAt).not.toBeNull();
  });

  it('cesse de l’être passé les 24 heures', async () => {
    const { gm, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId, { startsInMs: -25 * hour });

    expect((await readTable(gm, tableId)).nextSessionAt).toBeNull();
  });

  it('s’efface derrière la suivante plutôt que de la masquer', async () => {
    const { gm, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId, { startsInMs: -25 * hour });
    const next = await scheduleSession(gm, tableId, { startsInMs: 3 * 24 * hour });

    expect((await readTable(gm, tableId)).nextSessionAt).toBe(next.startsAt);
  });
});

describe('La fermeture des inscriptions', () => {
  it('accepte une réponse tant que la séance n’a pas commencé', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId, { startsInMs: 48 * hour });

    expect((await answer(player, session.id, 'yes')).statusCode).toBe(200);
  });

  it('refuse une réponse une fois la séance commencée', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId, {
      startsInMs: -2 * hour,
      createdAgoMs: 3 * hour,
    });

    const response = await answer(player, session.id, 'yes');

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('closes');
    expect(await prisma.sessionAttendance.count()).toBe(0);
  });

  it('accepte encore dans l’heure qui suit la création, séance déjà commencée',
    async () => {
      const { gm, player, tableId } = await tableWithPlayer();
      // Proposée il y a dix minutes pour il y a cinq : le retardataire a le
      // temps de voir la notification et de répondre.
      const session = await scheduleSession(gm, tableId, {
        startsInMs: -5 * 60 * 1000,
        createdAgoMs: 10 * 60 * 1000,
      });

      expect((await answer(player, session.id, 'yes')).statusCode).toBe(200);
    });

  it('refuse aussi de changer d’avis', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId, { startsInMs: 48 * hour });
    expect((await answer(player, session.id, 'yes')).statusCode).toBe(200);

    // La séance a commencé depuis, et la grâce d'une heure est passée.
    await prisma.gameSession.update({
      where: { id: session.id },
      data: {
        startsAt: new Date(Date.now() - hour),
        createdAt: new Date(Date.now() - 3 * hour),
      },
    });

    expect((await answer(player, session.id, 'no')).statusCode).toBe(409);

    const stored = await prisma.sessionAttendance.findFirstOrThrow();
    expect(stored.status).toBe('yes');
  });

  it('refuse de nommer un personnage une fois les inscriptions closes', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId, { startsInMs: 48 * hour });
    expect((await answer(player, session.id, 'yes')).statusCode).toBe(200);

    await prisma.gameSession.update({
      where: { id: session.id },
      data: {
        startsAt: new Date(Date.now() - hour),
        createdAt: new Date(Date.now() - 3 * hour),
      },
    });

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${session.id}/attendance/character`,
      headers: player.authHeader,
      payload: { characterId: null },
    });

    expect(response.statusCode).toBe(409);
  });

  it('laisse le MJ corriger sa séance pendant la partie', async () => {
    const { gm, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId, {
      startsInMs: -2 * hour,
      createdAgoMs: 3 * hour,
    });

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
      payload: { location: 'Finalement chez Marie' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().location).toBe('Finalement chez Marie');
  });
});
