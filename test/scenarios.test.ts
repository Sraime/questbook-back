import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';
import { createTable } from './helpers/tables.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function insertScenario(options: {
  title?: string;
  grantOnSignup?: boolean;
} = {}) {
  return prisma.scenario.create({
    data: {
      title: options.title ?? "Le Phare de Kerloc'h",
      description: 'Un gardien disparaît sur la côte.',
      context: "Kerloc'h, 1924.",
      minRecommendedPlayers: 2,
      maxRecommendedPlayers: 5,
      averageDurationMinutes: 180,
      rundownMarkdown: '## Mise en place\n\nDonner le télégramme.',
      grantOnSignup: options.grantOnSignup ?? false,
      annexes: {
        create: [
          {
            sortOrder: 0,
            title: 'Télégramme',
            kind: 'handout',
            contentMarkdown: 'GARDEN DISPARU STOP',
          },
        ],
      },
    },
  });
}

describe('scenarios', () => {
  it('lists nothing when the user owns no scenario', async () => {
    const user = await signIn(context);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/scenarios',
      headers: user.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ scenarios: [] });
  });

  it('grants starter scenarios on sign-in and lists only those', async () => {
    const starter = await insertScenario({ grantOnSignup: true });
    const hidden = await insertScenario({ title: 'Réservé à la boutique' });

    const user = await signIn(context);
    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/scenarios',
      headers: user.authHeader,
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().scenarios).toEqual([
      {
        id: starter.id,
        title: starter.title,
        description: starter.description,
        minRecommendedPlayers: 2,
        maxRecommendedPlayers: 5,
        averageDurationMinutes: 180,
      },
    ]);
    expect(list.json().scenarios.map((row: { id: string }) => row.id)).not.toContain(
      hidden.id,
    );
  });

  it('returns the full document of an owned scenario', async () => {
    const starter = await insertScenario({ grantOnSignup: true });
    const user = await signIn(context);

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/scenarios/${starter.id}`,
      headers: user.authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(starter.id);
    expect(body.context).toBe("Kerloc'h, 1924.");
    expect(body.rundownMarkdown).toContain('Mise en place');
    expect(body.annexes).toHaveLength(1);
    expect(body.annexes[0]).toMatchObject({
      title: 'Télégramme',
      kind: 'handout',
    });
  });

  it('hides unowned and unknown scenarios behind the same 404', async () => {
    const hidden = await insertScenario({ title: 'Pas à toi' });
    const user = await signIn(context);

    const unowned = await context.app.inject({
      method: 'GET',
      url: `/api/v1/scenarios/${hidden.id}`,
      headers: user.authHeader,
    });
    const unknown = await context.app.inject({
      method: 'GET',
      url: '/api/v1/scenarios/11111111-1111-4111-8111-111111111111',
      headers: user.authHeader,
    });

    expect(unowned.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(unowned.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(unowned.json().error.message).not.toMatch(/own|owner|permission/i);
  });

  it('lets a game master attach an owned scenario to a session', async () => {
    const starter = await insertScenario({ grantOnSignup: true });
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/sessions`,
      headers: gm.authHeader,
      payload: {
        title: 'Soirée phare',
        startsAt: '2026-10-01T19:00:00.000Z',
        location: 'Chez Robin',
        scenarioId: starter.id,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().scenarioId).toBe(starter.id);
    expect(created.json().scenario).toEqual({
      id: starter.id,
      title: starter.title,
    });
  });

  it('refuses to attach a scenario the game master does not own', async () => {
    const hidden = await insertScenario({ title: 'Boutique' });
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/sessions`,
      headers: gm.authHeader,
      payload: {
        title: 'Soirée',
        startsAt: '2026-10-01T19:00:00.000Z',
        location: 'Chez Robin',
        scenarioId: hidden.id,
      },
    });

    expect(created.statusCode).toBe(404);
  });

  it('clears the scenario on a session when the GM sends null', async () => {
    const starter = await insertScenario({ grantOnSignup: true });
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/sessions`,
      headers: gm.authHeader,
      payload: {
        title: 'Soirée',
        startsAt: '2026-10-01T19:00:00.000Z',
        location: 'Chez Robin',
        scenarioId: starter.id,
      },
    });

    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${created.json().id}`,
      headers: gm.authHeader,
      payload: { scenarioId: null },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().scenarioId).toBeNull();
    expect(patched.json().scenario).toBeNull();
  });
});
