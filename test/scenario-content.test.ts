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

/// `grantOnSignup` plutot qu'une possession posee a la main : c'est le chemin
/// que prend le vrai catalogue, et il donne le scenario au MJ des qu'il le
/// reclame.
async function insertScenario() {
  return prisma.scenario.create({
    data: {
      title: "Le Phare de Kerloc'h",
      description: 'Un gardien disparait sur la cote.',
      context: "Kerloc'h, 1924.",
      minRecommendedPlayers: 2,
      maxRecommendedPlayers: 5,
      averageDurationMinutes: 180,
      rundownMarkdown: '## Mise en place',
      grantOnSignup: true,
      npcs: {
        create: [
          { sortOrder: 0, name: 'Mariette Le Goff', description: 'Ment sur les dates.' },
          { sortOrder: 1, name: 'Yann Le Goff', description: 'Terre dans la crique.' },
        ],
      },
      clues: {
        create: [
          { sortOrder: 0, title: 'Telegramme de Quimper', contentMarkdown: 'GARDIEN DISPARU STOP' },
          { sortOrder: 1, title: 'Carnet de la crique', contentMarkdown: '> 12 mars' },
        ],
      },
    },
    include: { npcs: { orderBy: { sortOrder: 'asc' } }, clues: { orderBy: { sortOrder: 'asc' } } },
  });
}

async function tableWithScenario(options: { attach?: boolean } = {}) {
  const scenario = await insertScenario();
  const gm = await signIn(context, 'gm');
  const alice = await signIn(context, 'alice');
  const table = await createTable(context, gm);
  await joinTable(context, gm, alice, table.id);

  const session = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${table.id}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Soiree phare',
      startsAt: '2026-10-12T19:00:00.000Z',
      location: 'Chez Robin',
      ...(options.attach === false ? {} : { scenarioId: scenario.id }),
    },
  });
  expect(session.statusCode).toBe(201);

  return { scenario, gm, alice, sessionId: session.json().id as string };
}

const listNpcs = (as: SignedInUser, sessionId: string) =>
  context.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${sessionId}/npcs`,
    headers: as.authHeader,
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

describe("a session plays its scenario's cast and handouts", () => {
  it('lists the scenario characters before those the game master wrote', async () => {
    const { gm, sessionId } = await tableWithScenario();

    await context.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/npcs`,
      headers: gm.authHeader,
      payload: { name: 'Le facteur', description: 'Invente sur le pouce.' },
    });

    const response = await listNpcs(gm, sessionId);

    expect(response.statusCode).toBe(200);
    expect(response.json().npcs.map((npc: { name: string }) => npc.name)).toEqual([
      'Mariette Le Goff',
      'Yann Le Goff',
      'Le facteur',
    ]);
    expect(response.json().npcs.map((npc: { origin: string }) => npc.origin)).toEqual([
      'scenario',
      'scenario',
      'gameMaster',
    ]);
  });

  it('lists the scenario clues, shared with nobody until the game master says so', async () => {
    const { gm, sessionId } = await tableWithScenario();

    const response = await listClues(gm, sessionId);

    expect(response.statusCode).toBe(200);
    expect(response.json().clues).toHaveLength(2);
    expect(response.json().clues[0]).toMatchObject({
      title: 'Telegramme de Quimper',
      origin: 'scenario',
      sharedWith: [],
    });
  });

  /// Une seance sans scenario ne va rien chercher : c'est le cas de la
  /// majorite des soirees, et il ne doit rien couter.
  it('shows nothing extra to a session that plays no scenario', async () => {
    const { gm, sessionId } = await tableWithScenario({ attach: false });

    expect((await listNpcs(gm, sessionId)).json().npcs).toEqual([]);
    expect((await listClues(gm, sessionId)).json().clues).toEqual([]);
  });

  it('refuses to rewrite or destroy what the scenario ships', async () => {
    const { scenario, gm, sessionId } = await tableWithScenario();
    const npcId = scenario.npcs[0].id;
    const clueId = scenario.clues[0].id;

    const patchedNpc = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}/npcs/${npcId}`,
      headers: gm.authHeader,
      payload: { name: 'Mariette, mais en mieux' },
    });
    const removedClue = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}/clues/${clueId}`,
      headers: gm.authHeader,
    });

    expect(patchedNpc.statusCode).toBe(400);
    expect(removedClue.statusCode).toBe(400);
    // Surtout pas 404 : le MJ a l'element sous les yeux, et on l'enverrait
    // chercher un bug la ou il n'y a qu'une regle.
    expect(patchedNpc.json().error.message).toMatch(/scenario/i);
    expect(removedClue.json().error.message).toMatch(/scenario/i);
  });

  it('hands a scenario clue to a player like any other', async () => {
    const { scenario, gm, alice, sessionId } = await tableWithScenario();
    const clueId = scenario.clues[1].id;

    const shared = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${sessionId}/clues/${clueId}/access`,
      headers: gm.authHeader,
      payload: { userIds: [alice.userId] },
    });

    expect(shared.statusCode).toBe(200);
    expect(shared.json().sharedWith).toEqual([alice.userId]);

    const mine = await myClues(alice, sessionId);
    expect(mine.json().clues).toHaveLength(1);
    expect(mine.json().clues[0]).toMatchObject({
      id: clueId,
      title: 'Carnet de la crique',
    });
    // Rien ne dit au joueur d'ou vient ce qu'il lit, et c'est voulu.
    expect(mine.json().clues[0]).not.toHaveProperty('origin');
  });

  /// Le meme indice de catalogue se transmet soir apres soir, ailleurs, a
  /// d'autres gens : le partage d'une table ne doit pas suivre.
  it('keeps one eveningâ€™s sharing out of anotherâ€™s', async () => {
    const first = await tableWithScenario();
    const clueId = first.scenario.clues[0].id;

    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${first.sessionId}/clues/${clueId}/access`,
      headers: first.gm.authHeader,
      payload: { userIds: [first.alice.userId] },
    });

    const second = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${(await createTable(context, first.gm)).id}/sessions`,
      headers: first.gm.authHeader,
      payload: {
        title: 'Autre soiree',
        startsAt: '2026-11-12T19:00:00.000Z',
        location: 'Ailleurs',
        scenarioId: first.scenario.id,
      },
    });

    const clues = await listClues(first.gm, second.json().id);
    expect(clues.json().clues[0]).toMatchObject({ id: clueId, sharedWith: [] });
  });

  /// Retirer le scenario reprend ce qu'il avait distribue : le MJ n'a jamais
  /// pu modifier ces indices, donc rien de son travail ne disparait.
  it('takes the clues back when the scenario leaves the session', async () => {
    const { scenario, gm, alice, sessionId } = await tableWithScenario();
    const clueId = scenario.clues[0].id;

    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${sessionId}/clues/${clueId}/access`,
      headers: gm.authHeader,
      payload: { userIds: [alice.userId] },
    });
    expect((await myClues(alice, sessionId)).json().clues).toHaveLength(1);

    const detached = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      headers: gm.authHeader,
      payload: { scenarioId: null },
    });

    expect(detached.statusCode).toBe(200);
    expect((await listClues(gm, sessionId)).json().clues).toEqual([]);
    expect((await myClues(alice, sessionId)).json().clues).toEqual([]);
    expect(
      await prisma.scenarioClueAccess.count({ where: { sessionId } }),
    ).toBe(0);
  });
});
