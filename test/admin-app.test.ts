import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAdminTestApp,
  createTestApp,
  prisma,
  resetDatabase,
  type TestContext,
} from './helpers/test-app.js';

let admin: FastifyInstance;
let product: TestContext;

// No per-test reset: nothing here writes, and the point of the suite is the
// shape of the two applications rather than the state of the database.
beforeAll(async () => {
  await resetDatabase();
  admin = await createAdminTestApp();
  product = await createTestApp();
});

afterAll(async () => {
  await admin.close();
  await prisma.$disconnect();
});

describe('the back office API', () => {
  it('answers /health once PostgreSQL does', async () => {
    const response = await admin.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('answers an unknown route in the same shape as the product API', async () => {
    const response = await admin.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  /// The two applications exist precisely so that neither carries the other's
  /// routes. Were they ever merged back behind one listener, these two would
  /// be the first to say so.
  it('serves none of the product routes', async () => {
    for (const url of ['/api/v1/auth/me', '/api/v1/characters', '/api/v1/tables']) {
      const response = await admin.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('is absent from the product API', async () => {
    const response = await product.app.inject({ method: 'GET', url: '/admin' });

    expect(response.statusCode).toBe(404);
  });

  /// The local front reaches this API through its dev server's proxy, so the
  /// browser only ever talks to its own origin. Granting one here would be the
  /// first hole in a door whose whole defence is being closed.
  it('grants no browser origin', async () => {
    const response = await admin.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://quelquun.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
