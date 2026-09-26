import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminTestApp,
  createTestApp,
  prisma,
  resetDatabase,
  seedAdmin,
  signIn,
  totpFor,
  type SeededAdmin,
  type TestContext,
} from './helpers/test-app.js';
import { createTable } from './helpers/tables.js';

let product: TestContext;
let admin: FastifyInstance;
let account: SeededAdmin;
let authHeader: { authorization: string };

beforeEach(async () => {
  await resetDatabase();
  product = await createTestApp();
  admin = await createAdminTestApp();
  account = await seedAdmin();

  const signedIn = await admin.inject({
    method: 'POST',
    url: '/admin/auth/session',
    payload: { login: account.login, password: account.password, totp: totpFor(account) },
  });
  authHeader = { authorization: `Bearer ${signedIn.json().token}` };
});

afterAll(async () => {
  await prisma.$disconnect();
});

const draft = (over: Record<string, unknown> = {}) => ({
  title: 'La Cave aux echos',
  description: 'Une nuit sous la ville.',
  context: 'La ville est batie sur ses propres ruines.',
  rundownMarkdown: '## Ouverture\n\nUn cri monte du soupirail.',
  minRecommendedPlayers: 3,
  maxRecommendedPlayers: 5,
  averageDurationMinutes: 180,
  ...over,
});

const create = (body: Record<string, unknown> = draft()) =>
  admin.inject({ method: 'POST', url: '/admin/scenarios', headers: authHeader, payload: body });

const update = (id: string, body: Record<string, unknown>) =>
  admin.inject({
    method: 'PATCH',
    url: `/admin/scenarios/${id}`,
    headers: authHeader,
    payload: body,
  });

const detail = (id: string) =>
  admin.inject({ method: 'GET', url: `/admin/scenarios/${id}`, headers: authHeader });

const auditFor = (action: string) =>
  prisma.adminAuditEntry.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

describe('writing a scenario', () => {
  it('keeps the cast and the clues in the order they were sent', async () => {
    const response = await create(
      draft({
        npcs: [
          { name: 'Maitre Orvel', description: 'Archiviste, ment par omission.' },
          { name: 'La Veuve', description: 'Sait ou mene le tunnel.' },
        ],
        clues: [
          { title: 'Le telegramme', contentMarkdown: 'ARRIVE MARDI. NE PARLE A PERSONNE.' },
          { title: 'Le carnet trempe', contentMarkdown: 'Trois pages lisibles.' },
        ],
      }),
    );

    expect(response.statusCode).toBe(201);
    const scenario = response.json();
    expect(scenario.npcs.map((npc: { name: string }) => npc.name)).toEqual([
      'Maitre Orvel',
      'La Veuve',
    ]);
    expect(scenario.clues.map((clue: { title: string }) => clue.title)).toEqual([
      'Le telegramme',
      'Le carnet trempe',
    ]);
  });

  it('refuses a party range that admits nobody', async () => {
    const response = await create(draft({ minRecommendedPlayers: 5, maxRecommendedPlayers: 3 }));

    expect(response.statusCode).toBe(400);
  });

  it('refuses an adventure without a rundown', async () => {
    expect((await create(draft({ rundownMarkdown: '' }))).statusCode).toBe(400);
    expect((await create(draft({ title: '' }))).statusCode).toBe(400);
  });

  it('hands the adventure to the product API, which had no other way in', async () => {
    const created = await create(draft({ grantOnSignup: true, npcs: [{ name: 'La Veuve' }] }));

    // L'octroi se fait a la connexion : le compte doit venir apres.
    const player = await signIn(product, 'joueuse');
    const response = await product.app.inject({
      method: 'GET',
      url: `/api/v1/scenarios/${created.json().id}`,
      headers: { authorization: `Bearer ${player.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe('La Cave aux echos');
    expect(response.json().npcs).toHaveLength(1);
  });
});

describe('correcting a scenario', () => {
  it('changes one field without asking for the fifteen others', async () => {
    const created = (await create()).json();

    const response = await update(created.id, { grantOnSignup: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      grantOnSignup: true,
      title: 'La Cave aux echos',
      rundownMarkdown: '## Ouverture\n\nUn cri monte du soupirail.',
    });
  });

  it('refuses a correction that would close the party range', async () => {
    const created = (await create()).json();

    // Le minimum seul passe au-dessus du maximum enregistre.
    expect((await update(created.id, { minRecommendedPlayers: 9 })).statusCode).toBe(400);
  });

  it('refuses a body that asks for nothing', async () => {
    const created = (await create()).json();

    expect((await update(created.id, {})).statusCode).toBe(400);
  });

  it('keeps the identity of a character it edits, and drops the one left out', async () => {
    const created = (
      await create(
        draft({
          npcs: [{ name: 'Maitre Orvel' }, { name: 'La Veuve' }, { name: 'Le portier' }],
        }),
      )
    ).json();
    const [orvel, veuve] = created.npcs;

    const response = await update(created.id, {
      npcs: [
        { id: veuve.id, name: 'La Veuve', description: 'Sait ou mene le tunnel.' },
        { id: orvel.id, name: 'Maitre Orvel' },
        { name: 'Un chien' },
      ],
    });

    const npcs = response.json().npcs;
    expect(npcs.map((npc: { id: string }) => npc.id).slice(0, 2)).toEqual([veuve.id, orvel.id]);
    expect(npcs.map((npc: { name: string }) => npc.name)).toEqual([
      'La Veuve',
      'Maitre Orvel',
      'Un chien',
    ]);
    expect(npcs[0].description).toBe('Sait ou mene le tunnel.');
  });

  it('refuses a character borrowed from another adventure', async () => {
    const first = (await create(draft({ npcs: [{ name: 'La Veuve' }] }))).json();
    const second = (await create(draft({ title: 'Autre chose' }))).json();

    const response = await update(second.id, {
      npcs: [{ id: first.npcs[0].id, name: 'La Veuve' }],
    });

    expect(response.statusCode).toBe(400);
  });

  it('says how many players a removed clue was taken from', async () => {
    const created = (
      await create(draft({ clues: [{ title: 'Le telegramme', contentMarkdown: 'ARRIVE MARDI.' }] }))
    ).json();
    const clue = created.clues[0];

    const player = await signIn(product, 'joueuse');
    const table = await createTable(product, player);
    const session = await prisma.gameSession.create({
      data: {
        tableId: table.id,
        title: 'Seance',
        startsAt: new Date(),
        location: 'Chez Robin',
        scenarioId: created.id,
      },
    });
    await prisma.scenarioClueAccess.create({
      data: { sessionId: session.id, clueId: clue.id, userId: player.userId },
    });

    expect((await detail(created.id)).json().clues[0].sharedWith).toBe(1);

    const response = await update(created.id, { clues: [] });

    expect(response.json().clues).toEqual([]);
    const [entry] = await auditFor('scenario.update');
    expect(JSON.parse(entry.details!)).toMatchObject({ cluesRemoved: 1, revokedClueAccess: 1 });
  });
});

describe('the catalogue as a whole', () => {
  it('lists adventures by title, with what each one weighs', async () => {
    await create(draft({ title: 'Zone morte' }));
    await create(draft({ title: 'Aube grise', npcs: [{ name: 'La Veuve' }] }));

    const response = await admin.inject({
      method: 'GET',
      url: '/admin/scenarios',
      headers: authHeader,
    });

    const titles = response.json().map((scenario: { title: string }) => scenario.title);
    expect(titles).toEqual(['Aube grise', 'Zone morte']);
    expect(response.json()[0]).toMatchObject({ npcs: 1, clues: 0, owners: 0 });
  });

  it('answers nothing without a session', async () => {
    expect((await admin.inject({ method: 'GET', url: '/admin/scenarios' })).statusCode).toBe(401);
    expect(
      (await admin.inject({ method: 'POST', url: '/admin/scenarios', payload: draft() }))
        .statusCode,
    ).toBe(401);
  });

  it('names the adventure and the administrator in the audit log', async () => {
    const created = (await create()).json();
    await update(created.id, { title: 'La Cave aux murmures' });

    const entries = await prisma.adminAuditEntry.findMany({
      where: { targetType: 'scenario' },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries.map((entry) => entry.action)).toEqual(['scenario.create', 'scenario.update']);
    expect(entries.every((entry) => entry.targetId === created.id)).toBe(true);
    expect(entries.every((entry) => entry.adminId === account.id)).toBe(true);
  });

  it('answers 404 for an adventure that was never written', async () => {
    const response = await detail('00000000-0000-4000-8000-000000000000');

    expect(response.statusCode).toBe(404);
  });
});
