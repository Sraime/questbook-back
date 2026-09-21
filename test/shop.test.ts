import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function insertItem(
  options: {
    title?: string;
    type?: string;
    priceCents?: number;
    assetKey?: string | null;
    scenarioId?: string | null;
    sortOrder?: number;
  } = {},
) {
  return prisma.shopItem.create({
    data: {
      title: options.title ?? 'Le Grand Ancien',
      type: options.type ?? 'asset',
      description: "Le pion qui porte l'emblème de Questbook.",
      priceCents: options.priceCents ?? 0,
      imageKey: 'logo_mark',
      assetKey:
        options.assetKey === undefined ? 'grand_ancien' : options.assetKey,
      scenarioId: options.scenarioId ?? null,
      sortOrder: options.sortOrder ?? 0,
    },
  });
}

async function insertScenario(title = 'Le Phare de Kerloc’h') {
  return prisma.scenario.create({
    data: {
      title,
      description: 'Un gardien disparaît sur la côte.',
      context: 'Kerloc’h, 1924.',
      minRecommendedPlayers: 2,
      maxRecommendedPlayers: 5,
      averageDurationMinutes: 180,
      rundownMarkdown: '## Mise en place',
    },
  });
}

function purchase(authHeader: { authorization: string }, itemId: string) {
  return context.app.inject({
    method: 'POST',
    url: `/api/v1/shop/items/${itemId}/purchase`,
    headers: authHeader,
  });
}

describe('shop', () => {
  it('requires a signed-in caller', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
    });

    expect(response.statusCode).toBe(401);
  });

  it('lists the whole catalogue, owned or not', async () => {
    // Unlike scenarios, whose list is only what you hold: a shop that hid
    // what you have not bought would have nothing to sell.
    const first = await insertItem({ title: 'Le Grand Ancien', sortOrder: 0 });
    const second = await insertItem({
      title: 'Pack de départ',
      type: 'pack',
      sortOrder: 1,
      assetKey: null,
    });

    const user = await signIn(context);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
      headers: user.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      {
        id: first.id,
        title: 'Le Grand Ancien',
        type: 'asset',
        description: "Le pion qui porte l'emblème de Questbook.",
        priceCents: 0,
        imageKey: 'logo_mark',
        assetKey: 'grand_ancien',
        owned: false,
      },
      {
        id: second.id,
        title: 'Pack de départ',
        type: 'pack',
        description: "Le pion qui porte l'emblème de Questbook.",
        priceCents: 0,
        imageKey: 'logo_mark',
        assetKey: null,
        owned: false,
      },
    ]);
  });

  it('describes an article in the listing, not only on its page', async () => {
    // La description était réservée au détail. Un article `scenario` s'affiche
    // pleine largeur avec quelques lignes de ce dont il parle, et une
    // aventure dont on ne peut rien lire est une aventure que personne
    // n'ouvre.
    const scenario = await insertScenario();
    const item = await insertItem({
      title: 'Le Phare de Kerloc’h',
      type: 'scenario',
      assetKey: null,
      scenarioId: scenario.id,
    });
    const user = await signIn(context);

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
      headers: user.authHeader,
    });

    expect(list.json().items[0].description).toBe(
      "Le pion qui porte l'emblème de Questbook.",
    );

    // Le détail garde ce qu'il avait en plus : vers quelle aventure pointe
    // l'article.
    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/shop/items/${item.id}`,
      headers: user.authHeader,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: item.id,
      description: "Le pion qui porte l'emblème de Questbook.",
      scenarioId: scenario.id,
      owned: false,
    });
  });

  it('marks the article as owned once bought', async () => {
    const item = await insertItem();
    const user = await signIn(context);

    const bought = await purchase(user.authHeader, item.id);

    expect(bought.statusCode).toBe(200);
    expect(bought.json().owned).toBe(true);

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
      headers: user.authHeader,
    });

    expect(list.json().items[0].owned).toBe(true);
  });

  it('takes a second purchase without complaining', async () => {
    // A double tap must not surface an error, and the day money changes
    // hands that is exactly the property worth having.
    const item = await insertItem();
    const user = await signIn(context);

    await purchase(user.authHeader, item.id);
    const again = await purchase(user.authHeader, item.id);

    expect(again.statusCode).toBe(200);
    expect(again.json().owned).toBe(true);

    const rows = await prisma.shopItemOwnership.count({
      where: { userId: user.userId, itemId: item.id },
    });
    expect(rows).toBe(1);
  });

  it('leaves other accounts empty-handed', async () => {
    const item = await insertItem();
    const buyer = await signIn(context, 'google-sub-buyer');
    await purchase(buyer.authHeader, item.id);

    const other = await signIn(context, 'google-sub-other');
    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
      headers: other.authHeader,
    });

    expect(list.json().items[0].owned).toBe(false);
  });

  it('grants the adventure itself when a scenario article is bought', async () => {
    // Reading an adventure stays gated by scenario ownership, so nothing
    // downstream has to learn that a shop exists.
    const scenario = await insertScenario();
    const item = await insertItem({
      title: 'Le Phare de Kerloc’h',
      type: 'scenario',
      assetKey: null,
      scenarioId: scenario.id,
    });

    const user = await signIn(context);

    const before = await context.app.inject({
      method: 'GET',
      url: '/api/v1/scenarios',
      headers: user.authHeader,
    });
    expect(before.json().scenarios).toEqual([]);

    await purchase(user.authHeader, item.id);

    const after = await context.app.inject({
      method: 'GET',
      url: '/api/v1/scenarios',
      headers: user.authHeader,
    });
    expect(after.json().scenarios.map((row: { id: string }) => row.id)).toEqual([
      scenario.id,
    ]);
  });

  it('refuses to give away a priced article while payment is missing', async () => {
    const item = await insertItem({ priceCents: 499 });
    const user = await signIn(context);

    const response = await purchase(user.authHeader, item.id);

    expect(response.statusCode).toBe(400);
    expect(await prisma.shopItemOwnership.count()).toBe(0);
  });

  it('refuses a pack, which has no content to grant yet', async () => {
    const item = await insertItem({ type: 'pack', assetKey: null });
    const user = await signIn(context);

    const response = await purchase(user.authHeader, item.id);

    expect(response.statusCode).toBe(400);
    expect(await prisma.shopItemOwnership.count()).toBe(0);
  });

  it('answers 404 on an article that does not exist', async () => {
    const user = await signIn(context);
    const missing = '00000000-0000-4000-8000-000000000000';

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/shop/items/${missing}`,
      headers: user.authHeader,
    });
    expect(detail.statusCode).toBe(404);

    const bought = await purchase(user.authHeader, missing);
    expect(bought.statusCode).toBe(404);
  });
});
