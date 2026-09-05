import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  characterPayload,
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type SignedInUser,
  type TestContext,
} from './helpers/test-app.js';

/// These cover the contract the Flutter sync engine relies on: full-aggregate
/// pushes with last-write-wins, and incremental pulls that replicate deletions.
describe('Synchronisation', () => {
  let context: TestContext;
  let user: SignedInUser;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await context.app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    user = await signIn(context, 'sub-sync');
  });

  const push = (id: string, overrides: Record<string, unknown> = {}) =>
    context.app.inject({
      method: 'PUT',
      url: `/api/v1/characters/${id}`,
      headers: user.authHeader,
      payload: characterPayload(overrides),
    });

  it('creates the character when the id is unknown', async () => {
    const id = randomUUID();
    const response = await push(id);

    expect(response.statusCode).toBe(201);
    expect(response.json().id).toBe(id);
  });

  it('replaces the whole aggregate rather than merging children', async () => {
    const id = randomUUID();
    await push(id);

    const response = await push(id, {
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
      stats: [],
      inventory: [{ name: 'Carnet', qty: 1, weight: null }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().stats).toHaveLength(0);
    expect(response.json().inventory).toHaveLength(1);
    expect(response.json().inventory[0].name).toBe('Carnet');
  });

  it('refuses a stale push and hands back the winning version', async () => {
    const id = randomUUID();
    await push(id, { updatedAt: new Date(Date.now() + 60_000).toISOString() });

    const stale = await push(id, {
      name: 'Version périmée',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(stale.statusCode).toBe(409);
    const body = stale.json();
    expect(body.error.code).toBe('CONFLICT');
    // The client can adopt the server version without a second round trip.
    expect(body.error.details.character.name).toBe('Ernest Blackwood');
  });

  it('hides tombstones from a plain listing but reports them on an incremental pull', async () => {
    const id = randomUUID();
    await push(id);

    const before = new Date(Date.now() - 1000).toISOString();

    const deleted = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/characters/${id}`,
      headers: user.authHeader,
    });
    expect(deleted.statusCode).toBe(204);

    const plainList = await context.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: user.authHeader,
    });
    expect(plainList.json().characters).toHaveLength(0);

    const incremental = await context.app.inject({
      method: 'GET',
      url: `/api/v1/characters?since=${encodeURIComponent(before)}`,
      headers: user.authHeader,
    });
    const characters = incremental.json().characters;
    expect(characters).toHaveLength(1);
    expect(characters[0].id).toBe(id);
    expect(characters[0].deletedAt).not.toBeNull();
  });

  it('returns only what changed after the cursor', async () => {
    await push(randomUUID());

    const cursor = (
      await context.app.inject({
        method: 'GET',
        url: '/api/v1/characters',
        headers: user.authHeader,
      })
    ).json().syncedAt;

    const nothingNew = await context.app.inject({
      method: 'GET',
      url: `/api/v1/characters?since=${encodeURIComponent(cursor)}`,
      headers: user.authHeader,
    });
    expect(nothingNew.json().characters).toHaveLength(0);

    const secondId = randomUUID();
    await push(secondId);

    const afterCursor = await context.app.inject({
      method: 'GET',
      url: `/api/v1/characters?since=${encodeURIComponent(cursor)}`,
      headers: user.authHeader,
    });
    expect(afterCursor.json().characters).toHaveLength(1);
    expect(afterCursor.json().characters[0].id).toBe(secondId);
  });

  it('adopts a character created offline before the user signed in', async () => {
    // The app pushes its pre-existing Drift rows on first sign-in; they simply
    // become characters of the freshly authenticated account.
    const offlineId = randomUUID();
    const response = await push(offlineId, { name: 'Perso hors-ligne' });

    expect(response.statusCode).toBe(201);
    const stored = await prisma.character.findUniqueOrThrow({
      where: { id: offlineId },
    });
    expect(stored.userId).toBe(user.userId);
  });
});
