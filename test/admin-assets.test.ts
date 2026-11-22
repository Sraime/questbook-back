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

/// The smallest valid PNG there is: one transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/// Same picture, one byte apart at the end: another hash.
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);

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

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'Profond Shoggoth',
  description: 'Une masse informe aux mille yeux.',
  kind: 'character',
  image: PNG.toString('base64'),
  ...over,
});

const create = (body: Record<string, unknown> = draft()) =>
  admin.inject({ method: 'POST', url: '/admin/assets', headers: authHeader, payload: body });

const update = (id: string, body: Record<string, unknown>) =>
  admin.inject({ method: 'PATCH', url: `/admin/assets/${id}`, headers: authHeader, payload: body });

const shopFor = async (user: { authHeader: { authorization: string } }) =>
  (
    await product.app.inject({
      method: 'GET',
      url: '/api/v1/shop/items',
      headers: user.authHeader,
    })
  ).json().items as Array<{ id: string; assetKey: string | null; owned: boolean }>;

const purchase = (user: { authHeader: { authorization: string } }, itemId: string) =>
  product.app.inject({
    method: 'POST',
    url: `/api/v1/shop/items/${itemId}/purchase`,
    headers: user.authHeader,
  });

describe('adding an asset', () => {
  it('hosts the picture and puts an article in the shop', async () => {
    const response = await create(draft({ available: true }));

    expect(response.statusCode).toBe(201);
    const asset = response.json();
    expect(asset).toMatchObject({
      key: 'profond_shoggoth',
      title: 'Profond Shoggoth',
      kind: 'character',
      hosted: true,
      available: true,
      owners: 0,
    });
    expect(asset.imageHash).toMatch(/^[0-9a-f]{64}$/);

    const item = await prisma.shopItem.findUniqueOrThrow({ where: { id: asset.itemId } });
    expect(item).toMatchObject({ type: 'asset', priceCents: 0, assetKey: 'profond_shoggoth' });
  });

  it('keeps a new asset out of the shop until told otherwise', async () => {
    const asset = (await create()).json();
    const player = await signIn(product, 'player');

    expect(asset.available).toBe(false);
    expect(await shopFor(player)).toEqual([]);
  });

  it('never reuses a key, not even one bundled with the app', async () => {
    await prisma.shopItem.create({
      data: {
        title: 'Le Grand Ancien',
        type: 'asset',
        description: '',
        imageKey: 'logo_mark',
        assetKey: 'grand_ancien',
      },
    });

    const first = (await create(draft({ name: 'Grand Ancien' }))).json();
    const second = (await create(draft({ name: 'Grand  ancien !' }))).json();

    expect(first.key).toBe('grand_ancien_2');
    expect(second.key).toBe('grand_ancien_3');
  });

  it('refuses something that is not a picture, whatever it claims', async () => {
    const response = await create(draft({ image: Buffer.from('<svg/>').toString('base64') }));

    expect(response.statusCode).toBe(400);
    expect(await prisma.asset.count()).toBe(0);
  });

  it('refuses a picture over two megabytes', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const response = await create(draft({ image: big.toString('base64') }));

    expect(response.statusCode).toBe(400);
  });

  it('writes it down in the audit log', async () => {
    const asset = (await create()).json();

    const entries = await prisma.adminAuditEntry.findMany({ where: { action: 'asset.create' } });
    expect(entries).toHaveLength(1);
    expect(entries[0].targetId).toBe(asset.itemId);
  });
});

describe('managing an asset', () => {
  it('renames the article and the token together', async () => {
    const asset = (await create()).json();

    const response = await update(asset.itemId, { name: 'Shoggoth des abysses' });

    expect(response.json().title).toBe('Shoggoth des abysses');
    // The key does not follow: a placed token remembers it.
    expect(response.json().key).toBe('profond_shoggoth');
    const row = await prisma.asset.findUniqueOrThrow({ where: { key: 'profond_shoggoth' } });
    expect(row.name).toBe('Shoggoth des abysses');
  });

  it('changes the hash with the picture', async () => {
    const asset = (await create()).json();

    const updated = (await update(asset.itemId, { image: OTHER_PNG.toString('base64') })).json();

    expect(updated.imageHash).not.toBe(asset.imageHash);
  });

  it('withdraws an article from sale without taking it from its owners', async () => {
    const asset = (await create(draft({ available: true }))).json();
    const owner = await signIn(product, 'owner');
    const newcomer = await signIn(product, 'newcomer');
    expect((await purchase(owner, asset.itemId)).statusCode).toBe(200);

    await update(asset.itemId, { available: false });

    expect(await shopFor(newcomer)).toEqual([]);
    expect((await purchase(newcomer, asset.itemId)).statusCode).toBe(400);

    const owned = await shopFor(owner);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ assetKey: 'profond_shoggoth', owned: true });
    // A second tap from an owner stays the harmless no-op it always was.
    expect((await purchase(owner, asset.itemId)).statusCode).toBe(200);
  });

  it('lets the availability of a bundled asset be set, and nothing else', async () => {
    const bundled = await prisma.shopItem.create({
      data: {
        title: 'Le Grand Ancien',
        type: 'asset',
        description: '',
        imageKey: 'logo_mark',
        assetKey: 'grand_ancien',
      },
    });

    const listed = (
      await admin.inject({ method: 'GET', url: '/admin/assets', headers: authHeader })
    ).json();
    expect(listed[0]).toMatchObject({ key: 'grand_ancien', hosted: false, kind: null });

    expect((await update(bundled.id, { available: false })).statusCode).toBe(200);
    expect((await update(bundled.id, { image: PNG.toString('base64') })).statusCode).toBe(400);
    expect((await update(bundled.id, { kind: 'effect' })).statusCode).toBe(400);
  });

  it('shows the picture to the backoffice', async () => {
    const asset = (await create()).json();

    const response = await admin.inject({
      method: 'GET',
      url: `/admin/assets/${asset.itemId}/image`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload.equals(PNG)).toBe(true);
  });

  it('is closed to anyone without a session', async () => {
    const response = await admin.inject({ method: 'GET', url: '/admin/assets' });
    expect(response.statusCode).toBe(401);
  });
});

describe('the catalogue the app draws from', () => {
  it('lists every hosted asset, on sale or not', async () => {
    await create(draft({ available: true }));
    await create(draft({ name: 'Autel brise', kind: 'environment' }));
    const player = await signIn(product, 'player');

    const response = await product.app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: player.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().assets.map((a: { key: string }) => a.key)).toEqual([
      'autel_brise',
      'profond_shoggoth',
    ]);
  });

  it('serves the picture, and spares a second download', async () => {
    const asset = (await create()).json();
    const player = await signIn(product, 'player');

    const first = await product.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.key}/image`,
      headers: player.authHeader,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.rawPayload.equals(PNG)).toBe(true);

    const again = await product.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.key}/image`,
      headers: { ...player.authHeader, 'if-none-match': `"${asset.imageHash}"` },
    });
    expect(again.statusCode).toBe(304);
  });

  it('requires a signed-in caller', async () => {
    const response = await product.app.inject({ method: 'GET', url: '/api/v1/assets' });
    expect(response.statusCode).toBe(401);
  });
});
