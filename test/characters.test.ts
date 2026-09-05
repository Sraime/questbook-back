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

describe('Characters and inventory', () => {
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
    user = await signIn(context, 'sub-owner');
  });

  const createCharacter = async (
    as: SignedInUser = user,
    overrides: Record<string, unknown> = {},
  ) => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: as.authHeader,
      payload: characterPayload(overrides),
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  it('requires authentication', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates a character with its stats, resources and inventory', async () => {
    const character = await createCharacter();

    expect(character.name).toBe('Ernest Blackwood');
    expect(character.stats).toHaveLength(2);
    expect(character.resources).toHaveLength(1);
    expect(character.inventory).toHaveLength(1);
    expect(character.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a client-generated id so Drift and the API share one identity', async () => {
    const id = randomUUID();
    const character = await createCharacter(user, { id });
    expect(character.id).toBe(id);
  });

  it('rejects an invalid payload with a validation error', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: user.authHeader,
      payload: characterPayload({ name: '', level: 0 }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('never leaks another account characters', async () => {
    const mine = await createCharacter();
    const other = await signIn(context, 'sub-intruder');

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: other.authHeader,
    });
    expect(list.json().characters).toHaveLength(0);

    // 404 rather than 403: an intruder must not learn that the id exists.
    const direct = await context.app.inject({
      method: 'GET',
      url: `/api/v1/characters/${mine.id}`,
      headers: other.authHeader,
    });
    expect(direct.statusCode).toBe(404);
  });

  it('refuses to let one account claim an id owned by another', async () => {
    const mine = await createCharacter();
    const other = await signIn(context, 'sub-intruder');

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/characters/${mine.id}`,
      headers: other.authHeader,
      payload: characterPayload({ updatedAt: new Date(Date.now() + 60_000).toISOString() }),
    });

    expect(response.statusCode).toBe(409);
  });

  it('updates scalar fields with PATCH', async () => {
    const character = await createCharacter();

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/characters/${character.id}`,
      headers: user.authHeader,
      payload: { name: 'Ernest le Sage', level: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Ernest le Sage');
    expect(response.json().level).toBe(3);
  });

  describe('inventory', () => {
    it('adds, updates and removes an item', async () => {
      const character = await createCharacter();

      const added = await context.app.inject({
        method: 'POST',
        url: `/api/v1/characters/${character.id}/inventory`,
        headers: user.authHeader,
        payload: { name: 'Revolver .38', qty: 1, weight: '1 kg' },
      });
      expect(added.statusCode).toBe(201);
      const itemId = added.json().id;

      const updated = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/characters/${character.id}/inventory/${itemId}`,
        headers: user.authHeader,
        payload: { qty: 2 },
      });
      expect(updated.json().qty).toBe(2);
      expect(updated.json().name).toBe('Revolver .38');

      const removed = await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/characters/${character.id}/inventory/${itemId}`,
        headers: user.authHeader,
      });
      expect(removed.statusCode).toBe(204);

      const listed = await context.app.inject({
        method: 'GET',
        url: `/api/v1/characters/${character.id}/inventory`,
        headers: user.authHeader,
      });
      expect(listed.json().map((item: { name: string }) => item.name)).toEqual([
        'Lampe torche',
      ]);
    });

    it('moves the character clock so other devices notice the change', async () => {
      const character = await createCharacter();

      await context.app.inject({
        method: 'POST',
        url: `/api/v1/characters/${character.id}/inventory`,
        headers: user.authHeader,
        payload: { name: 'Corde', qty: 1 },
      });

      const after = await context.app.inject({
        method: 'GET',
        url: `/api/v1/characters/${character.id}`,
        headers: user.authHeader,
      });
      expect(new Date(after.json().updatedAt).getTime()).toBeGreaterThan(
        new Date(character.updatedAt).getTime(),
      );
    });

    it('refuses an item belonging to another character', async () => {
      const first = await createCharacter();
      const second = await createCharacter(user, { name: 'Autre' });

      const response = await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/characters/${second.id}/inventory/${first.inventory[0].id}`,
        headers: user.authHeader,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('stats and resources', () => {
    it('updates a stat addressed by kind and key', async () => {
      const character = await createCharacter();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/characters/${character.id}/stats/skill/bibliotheque`,
        headers: user.authHeader,
        payload: { value: 65 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().value).toBe(65);
    });

    it('404s on a stat the character does not have', async () => {
      const character = await createCharacter();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/characters/${character.id}/stats/skill/inexistante`,
        headers: user.authHeader,
        payload: { value: 10 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('clamps a resource between 0 and its max', async () => {
      const character = await createCharacter();
      const url = `/api/v1/characters/${character.id}/resources/pv`;

      const overflow = await context.app.inject({
        method: 'PATCH',
        url,
        headers: user.authHeader,
        payload: { current: 999 },
      });
      expect(overflow.json().current).toBe(11);

      const underflow = await context.app.inject({
        method: 'PATCH',
        url,
        headers: user.authHeader,
        payload: { current: -5 },
      });
      expect(underflow.json().current).toBe(0);
    });
  });
});
