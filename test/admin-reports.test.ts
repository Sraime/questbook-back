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
  type SignedInUser,
  type TestContext,
} from './helpers/test-app.js';
import { createTable, joinTable } from './helpers/tables.js';

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
  expect(signedIn.statusCode).toBe(201);
  authHeader = { authorization: `Bearer ${signedIn.json().token}` };
});

afterAll(async () => {
  await prisma.$disconnect();
});

/// Les dossiers naissent par l'API du produit, jamais fabriques a la main :
/// c'est le seul moyen que la file lise ce qu'un joueur depose vraiment,
/// instantane compris.
async function aTableWithAReport(): Promise<{
  reporter: SignedInUser;
  reported: SignedInUser;
  tableId: string;
  reportId: string;
}> {
  const gm = await signIn(product, 'gm');
  const player = await signIn(product, 'player');
  const table = await createTable(product, gm, 'Le cercle de Providence');
  await joinTable(product, gm, player, table.id);

  const created = await product.app.inject({
    method: 'POST',
    url: '/api/v1/reports',
    headers: player.authHeader,
    payload: {
      contentType: 'table',
      contentId: table.id,
      reason: 'Le titre est une insulte a peine deguisee.',
    },
  });
  expect(created.statusCode).toBe(201);

  return {
    reporter: player,
    reported: gm,
    tableId: table.id as string,
    reportId: created.json().id as string,
  };
}

const list = (query = '') =>
  admin.inject({ method: 'GET', url: `/admin/reports${query}`, headers: authHeader });

describe('the report queue', () => {
  it('shows a freshly filed report as open', async () => {
    const { reportId, reported } = await aTableWithAReport();

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(1);
    expect(response.json().items[0]).toMatchObject({
      id: reportId,
      status: 'open',
      contentType: 'table',
      reason: 'Le titre est une insulte a peine deguisee.',
      reportedUser: { id: reported.userId, email: reported.email },
    });
  });

  it('is closed to anyone without a session', async () => {
    await aTableWithAReport();

    const response = await admin.inject({ method: 'GET', url: '/admin/reports' });

    expect(response.statusCode).toBe(401);
  });

  /// The oldest first: the queue is read by its most urgent end, and that is
  /// the one approaching the twenty-four hours the terms announce.
  it('puts the oldest first', async () => {
    const { reportId } = await aTableWithAReport();
    await prisma.report.update({
      where: { id: reportId },
      data: { createdAt: new Date(Date.now() - 86_400_000) },
    });

    const second = await signIn(product, 'autre');
    await prisma.report.create({
      data: {
        reporterId: second.userId,
        reportedUserId: (await prisma.report.findFirstOrThrow()).reportedUserId,
        contentType: 'user',
        contentId: 'peu-importe',
        snapshot: '{}',
        reason: 'Plus recent.',
      },
    });

    const items = list().then((response) => response.json().items);

    expect((await items).map((item: { id: string }) => item.id)[0]).toBe(reportId);
  });

  it('filters by status and counts what it filtered', async () => {
    const { reportId } = await aTableWithAReport();

    expect((await list('?status=resolved')).json()).toEqual({ items: [], total: 0 });

    await admin.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}/resolve`,
      headers: authHeader,
      payload: { resolution: 'dismissed' },
    });

    expect((await list('?status=open')).json().total).toBe(0);
    expect((await list('?status=resolved')).json().total).toBe(1);
  });

  it('paginates', async () => {
    const { reportId } = await aTableWithAReport();

    const page = await list('?limit=1&offset=0');
    expect(page.json().items).toHaveLength(1);
    expect(page.json().total).toBe(1);

    expect((await list('?limit=1&offset=1')).json().items).toHaveLength(0);
    expect((await list('?limit=0')).statusCode).toBe(400);
  });
});

describe('a report file', () => {
  it('carries the snapshot the server took, not what the caller claimed', async () => {
    const { reportId, reporter, reported } = await aTableWithAReport();

    const response = await admin.inject({
      method: 'GET',
      url: `/admin/reports/${reportId}`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().snapshot).toMatchObject({ Titre: 'Le cercle de Providence' });
    expect(response.json().reporter).toMatchObject({ id: reporter.userId });
    expect(response.json().reportedUser).toMatchObject({ id: reported.userId });
  });

  /// Rewriting the title must not rewrite the file: that is the whole reason
  /// the snapshot exists.
  it('keeps saying what the content said, even once it has been changed', async () => {
    const { reportId, reported, tableId } = await aTableWithAReport();

    await product.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${tableId}`,
      headers: reported.authHeader,
      payload: { title: 'Un titre parfaitement convenable' },
    });

    const response = await admin.inject({
      method: 'GET',
      url: `/admin/reports/${reportId}`,
      headers: authHeader,
    });

    expect(response.json().snapshot.Titre).toBe('Le cercle de Providence');
  });

  /// Two different people reporting the same person says something no single
  /// file says. It is the most useful signal of the lot.
  it('gathers the other files against the same account', async () => {
    const { reportId, reported } = await aTableWithAReport();

    const third = await signIn(product, 'troisieme');
    await prisma.report.create({
      data: {
        reporterId: third.userId,
        reportedUserId: reported.userId,
        contentType: 'user',
        contentId: reported.userId,
        snapshot: '{"Pseudo":"Test User"}',
        reason: 'Deuxieme personne a le signaler.',
      },
    });

    const response = await admin.inject({
      method: 'GET',
      url: `/admin/reports/${reportId}`,
      headers: authHeader,
    });

    expect(response.json().otherReportsOnSameUser).toHaveLength(1);
    expect(response.json().otherReportsOnSameUser[0].reason).toBe(
      'Deuxieme personne a le signaler.',
    );
  });

  it('answers 404 for an unknown file', async () => {
    const response = await admin.inject({
      method: 'GET',
      url: '/admin/reports/2f1b8c4e-0000-4000-8000-000000000000',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('deciding a report', () => {
  const resolve = (id: string, payload: Record<string, unknown>) =>
    admin.inject({
      method: 'POST',
      url: `/admin/reports/${id}/resolve`,
      headers: authHeader,
      payload,
    });

  it('records the decision, its note and who took it', async () => {
    const { reportId } = await aTableWithAReport();

    const response = await resolve(reportId, {
      resolution: 'warned',
      note: 'Averti par courriel, titre corrige depuis.',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'resolved',
      resolution: 'warned',
      resolutionNote: 'Averti par courriel, titre corrige depuis.',
      resolvedBy: 'robin',
    });
    expect(response.json().resolvedAt).toEqual(expect.any(String));
  });

  /// A double click must not move the moment the file was decided, the same
  /// way `POST /auth/terms` does not move a consent.
  it('is idempotent without moving the date', async () => {
    const { reportId } = await aTableWithAReport();

    const first = await resolve(reportId, { resolution: 'dismissed' });
    const second = await resolve(reportId, { resolution: 'warned' });

    expect(second.statusCode).toBe(200);
    expect(second.json().resolution).toBe('dismissed');
    expect(second.json().resolvedAt).toBe(first.json().resolvedAt);
  });

  /// `suspended` and `deleted` say what was decided; they do not sanction
  /// anyone by themselves, `/admin/users/:id` does. The two gestures stay
  /// apart on purpose: an account is often suspended for a cluster of files
  /// rather than the one on screen, and a file is sometimes closed without
  /// anybody being sanctioned.
  it('accepts every decision of the vocabulary, and nothing else', async () => {
    const { reportId } = await aTableWithAReport();

    for (const resolution of ['dismissed', 'warned', 'suspended', 'deleted']) {
      await prisma.report.update({
        where: { id: reportId },
        data: { status: 'open', resolvedAt: null },
      });

      const response = await resolve(reportId, { resolution });
      expect(response.statusCode, resolution).toBe(200);
      expect(response.json().resolution, resolution).toBe(resolution);
    }

    expect((await resolve(reportId, { resolution: 'nawak' })).statusCode).toBe(400);
  });

  it('answers 404 for an unknown file', async () => {
    const response = await resolve('2f1b8c4e-0000-4000-8000-000000000000', {
      resolution: 'dismissed',
    });

    expect(response.statusCode).toBe(404);
  });

  it('leaves an audit line naming the file and the decision', async () => {
    const { reportId } = await aTableWithAReport();
    await resolve(reportId, { resolution: 'warned', note: 'Un mot du support.' });

    const entry = await prisma.adminAuditEntry.findFirstOrThrow({
      where: { action: 'report.resolve' },
    });

    expect(entry.adminId).toBe(account.id);
    expect(entry.targetType).toBe('report');
    expect(entry.targetId).toBe(reportId);
    expect(JSON.parse(entry.details ?? '{}')).toEqual({ resolution: 'warned' });
  });

  /// Reading the queue is the ordinary gesture of the desk; a line per refresh
  /// would drown the ones that matter.
  it('does not audit merely reading the queue', async () => {
    const { reportId } = await aTableWithAReport();
    await list();
    await admin.inject({
      method: 'GET',
      url: `/admin/reports/${reportId}`,
      headers: authHeader,
    });

    const actions = await prisma.adminAuditEntry.findMany({ select: { action: true } });
    expect(actions.map((entry) => entry.action)).toEqual(['login.success']);
  });
});
