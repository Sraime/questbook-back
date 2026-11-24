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
  type TestContext,
} from './helpers/test-app.js';

let product: TestContext;
let admin: FastifyInstance;
let authHeader: { authorization: string };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

beforeEach(async () => {
  await resetDatabase();
  product = await createTestApp();
  admin = await createAdminTestApp();
  const account = await seedAdmin();

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

/// Un pion retire de la vente et une aventure qui ne se vend pas seule : ce
/// qu'un bundle sert justement a donner.
async function catalogue() {
  const token = await prisma.shopItem.create({
    data: {
      title: 'Le gardien',
      type: 'asset',
      description: '',
      imageKey: 'asset',
      assetKey: 'gardien',
      available: false,
    },
  });
  const scenario = await prisma.scenario.create({
    data: {
      title: 'Le Phare de Kerloc’h',
      description: 'Un gardien disparait.',
      context: 'Kerloc’h, 1924.',
      minRecommendedPlayers: 2,
      maxRecommendedPlayers: 5,
      averageDurationMinutes: 180,
      rundownMarkdown: '## Mise en place',
    },
  });
  return { token, scenario };
}

const create = (body: Record<string, unknown>) =>
  admin.inject({ method: 'POST', url: '/admin/bundles', headers: authHeader, payload: body });

const update = (id: string, body: Record<string, unknown>) =>
  admin.inject({ method: 'PATCH', url: `/admin/bundles/${id}`, headers: authHeader, payload: body });

describe('bundles in the backoffice', () => {
  it('gathers existing content into an article, kept off sale at first', async () => {
    const { token, scenario } = await catalogue();

    const response = await create({
      title: 'Le Phare, au complet',
      description: 'Le scenario et son gardien.',
      image: PNG.toString('base64'),
      assetItemIds: [token.id],
      scenarioIds: [scenario.id],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      title: 'Le Phare, au complet',
      priceCents: 0,
      available: false,
      owners: 0,
      contents: [
        { kind: 'asset', id: token.id, title: 'Le gardien', available: false },
        { kind: 'scenario', id: scenario.id, title: 'Le Phare de Kerloc’h', available: false },
      ],
    });
    expect(response.json().imageHash).toMatch(/^[0-9a-f]{64}$/);

    const player = await signIn(product, 'player');
    const shop = await product.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
      headers: player.authHeader,
    });
    expect(shop.json().items).toEqual([]);

    const image = await admin.inject({
      method: 'GET',
      url: `/admin/bundles/${response.json().itemId}/image`,
      headers: authHeader,
    });
    expect(image.rawPayload).toEqual(PNG);
  });

  it('only gathers what exists, and an asset only as an asset', async () => {
    const { token, scenario } = await catalogue();
    const scenarioItem = await prisma.shopItem.create({
      data: {
        title: 'Le Phare',
        type: 'scenario',
        description: '',
        imageKey: 'scroll',
        scenarioId: scenario.id,
      },
    });

    const base = { title: 'Lot', image: PNG.toString('base64') };
    expect(
      (await create({ ...base, scenarioIds: ['00000000-0000-4000-8000-000000000000'] }))
        .statusCode,
    ).toBe(400);
    expect((await create({ ...base, assetItemIds: [scenarioItem.id] })).statusCode).toBe(400);
    expect((await create({ ...base, assetItemIds: [token.id, token.id] })).statusCode).toBe(400);
    expect(await prisma.shopItem.count({ where: { type: 'bundle' } })).toBe(0);
  });

  it('refuses something that is not a picture', async () => {
    const response = await create({
      title: 'Lot',
      image: Buffer.from('<svg/>').toString('base64'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('changes its content as a whole, and goes on sale when told', async () => {
    const { token, scenario } = await catalogue();
    const bundle = (
      await create({
        title: 'Le Phare',
        image: PNG.toString('base64'),
        assetItemIds: [token.id],
      })
    ).json();

    const updated = await update(bundle.itemId, {
      scenarioIds: [scenario.id],
      assetItemIds: [],
      available: true,
      priceCents: 0,
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().contents).toEqual([
      { kind: 'scenario', id: scenario.id, title: 'Le Phare de Kerloc’h', available: false },
    ]);

    const player = await signIn(product, 'player');
    const bought = await product.app.inject({
      method: 'POST',
      url: `/api/v1/shop/items/${bundle.itemId}/purchase`,
      headers: player.authHeader,
    });
    expect(bought.statusCode).toBe(200);
    expect(
      await prisma.scenarioOwnership.count({ where: { userId: player.userId } }),
    ).toBe(1);

    const audit = await prisma.adminAuditEntry.findMany({
      where: { action: { startsWith: 'bundle.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((entry) => entry.action)).toEqual(['bundle.create', 'bundle.update']);
  });

  it('lists bundles, and nothing else', async () => {
    const { token } = await catalogue();
    await create({ title: 'Le Phare', image: PNG.toString('base64'), assetItemIds: [token.id] });

    const list = await admin.inject({ method: 'GET', url: '/admin/bundles', headers: authHeader });

    expect(list.json().map((bundle: { title: string }) => bundle.title)).toEqual(['Le Phare']);
  });
});
