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

/// Dio, the app's HTTP client, stamps `application/json` on every request it
/// sends, body or no body — and it offers no way to make that conditional per
/// request. Fastify's stock parser answers an empty body with a 400, so every
/// bodyless call (cancelling a session, leaving a table, declining an
/// invitation, marking notifications read) died before reaching its handler.
describe('empty JSON bodies', () => {
  const asJson = (user: { authHeader: Record<string, string> }) => ({
    ...user.authHeader,
    'content-type': 'application/json',
  });

  it('accepts a bodyless DELETE that claims to carry JSON', async () => {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${table.id}/sessions`,
      headers: gm.authHeader,
      payload: {
        title: 'Le manoir Corbitt',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        location: 'Chez Robin',
      },
    });

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${created.json().id}`,
      headers: asJson(gm),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('cancelled');
  });

  it('accepts a bodyless POST that claims to carry JSON', async () => {
    const user = await signIn(context, 'player');

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: asJson(user),
    });

    expect(response.statusCode).toBe(204);
  });

  /// Tolerating the empty body must not turn into tolerating a missing one:
  /// routes that declare a body schema still have the last word.
  it('still refuses an empty body where one is required', async () => {
    const user = await signIn(context, 'gm');

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tables',
      headers: asJson(user),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('still refuses a malformed body', async () => {
    const user = await signIn(context, 'gm');

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tables',
      headers: asJson(user),
      payload: '{"title": ',
    });

    expect(response.statusCode).toBe(400);
  });
});
