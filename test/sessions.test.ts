import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type SignedInUser,
  type TestContext,
} from './helpers/test-app.js';
import { createTable, joinTable } from './helpers/tables.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/// A table with one game master and one player, which is the smallest setup in
/// which notifications actually have an audience.
async function tableWithPlayer() {
  const gm = await signIn(context, 'gm');
  const player = await signIn(context, 'player');
  const table = await createTable(context, gm);
  await joinTable(context, gm, player, table.id);
  return { gm, player, tableId: table.id as string };
}

async function scheduleSession(
  gm: SignedInUser,
  tableId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${tableId}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Le manoir Corbitt',
      description: 'Apportez vos fiches',
      startsAt: '2026-10-12T19:00:00.000Z',
      location: 'Chez Robin',
      ...overrides,
    },
  });

  expect(response.statusCode).toBe(201);
  return response.json();
}

async function notificationTypes(user: SignedInUser): Promise<string[]> {
  const response = await context.app.inject({
    method: 'GET',
    url: '/api/v1/notifications',
    headers: user.authHeader,
  });
  return response.json().notifications.map((n: { type: string }) => n.type);
}

describe('Sessions', () => {
  it('notifies every member except the game master who scheduled it', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId);

    expect(await notificationTypes(player)).toContain('session_created');
    expect(await notificationTypes(gm)).not.toContain('session_created');
  });

  it('refuses to let a player schedule a session', async () => {
    const { player, tableId } = await tableWithPlayer();

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableId}/sessions`,
      headers: player.authHeader,
      payload: {
        title: 'Ma session',
        startsAt: '2026-10-12T19:00:00.000Z',
        location: 'Chez moi',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('surfaces the session as the table’s next date', async () => {
    const { gm, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId);

    const table = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${tableId}`,
      headers: gm.authHeader,
    });

    expect(table.json().nextSessionAt).toBe('2026-10-12T19:00:00.000Z');
  });

  it('notifies members when the date moves', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
      payload: { startsAt: '2026-10-19T19:00:00.000Z' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().startsAt).toBe('2026-10-19T19:00:00.000Z');
    expect(await notificationTypes(player)).toContain('session_updated');
  });

  it('notifies members when the place changes', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
      payload: { location: 'Au club, salle 2' },
    });

    expect(await notificationTypes(player)).toContain('session_updated');
  });

  /// Fixing a typo in the description at midnight should not wake anyone up.
  it('stays quiet when only the description changes', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
      payload: { description: 'Apportez vos fiches et vos dés' },
    });

    expect(await notificationTypes(player)).not.toContain('session_updated');
  });

  it('cancels rather than deletes, and tells the players', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('cancelled');
    expect(await notificationTypes(player)).toContain('session_cancelled');

    const sessions = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${tableId}/sessions`,
      headers: player.authHeader,
    });

    expect(sessions.json().sessions).toHaveLength(1);
  });

  it('hides a session from someone who is not at the table', async () => {
    const { gm, tableId } = await tableWithPlayer();
    const stranger = await signIn(context, 'stranger');
    const session = await scheduleSession(gm, tableId);

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
      headers: stranger.authHeader,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('Participation', () => {
  it('starts with no answer at all, which is not a refusal', async () => {
    const { gm, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    expect(session.myStatus).toBeNull();
    expect(session.attendances).toEqual([]);
  });

  it('notifies the game master when a player confirms', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${session.id}/attendance`,
      headers: player.authHeader,
      payload: { status: 'yes' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().myStatus).toBe('yes');
    expect(await notificationTypes(gm)).toContain('attendance_changed');
  });

  it('notifies the game master again when a player changes their mind', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    for (const status of ['yes', 'no'] as const) {
      await context.app.inject({
        method: 'PUT',
        url: `/api/v1/sessions/${session.id}/attendance`,
        headers: player.authHeader,
        payload: { status },
      });
    }

    const changes = (await notificationTypes(gm)).filter(
      (type) => type === 'attendance_changed',
    );
    expect(changes).toHaveLength(2);

    // One row per player, not one per answer.
    expect(await prisma.sessionAttendance.count()).toBe(1);
  });

  it('shows every answer to the whole table', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${session.id}/attendance`,
      headers: player.authHeader,
      payload: { status: 'yes' },
    });

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
    });

    expect(asGm.json().attendances).toHaveLength(1);
    expect(asGm.json().attendances[0].userId).toBe(player.userId);
    expect(asGm.json().myStatus).toBeNull();
  });

  it('refuses an answer to a cancelled session', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
    });

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${session.id}/attendance`,
      headers: player.authHeader,
      payload: { status: 'yes' },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('Notifications', () => {
  it('pushes to the devices a member registered', async () => {
    const { gm, player, tableId } = await tableWithPlayer();

    await context.app.inject({
      method: 'PUT',
      url: '/api/v1/devices',
      headers: player.authHeader,
      payload: { token: 'fcm-token-player', platform: 'android' },
    });

    context.push.sent.length = 0;
    await scheduleSession(gm, tableId);

    // Delivery is deliberately fire-and-forget, so it lands a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(context.push.sent).toHaveLength(1);
    expect(context.push.sent[0].tokens).toEqual(['fcm-token-player']);
    expect(context.push.sent[0].data?.type).toBe('session_created');
  });

  it('drops a device token Firebase reports as dead', async () => {
    const { gm, player, tableId } = await tableWithPlayer();

    await context.app.inject({
      method: 'PUT',
      url: '/api/v1/devices',
      headers: player.authHeader,
      payload: { token: 'stale-token', platform: 'android' },
    });

    context.push.staleTokens = ['stale-token'];
    await scheduleSession(gm, tableId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await prisma.deviceToken.count()).toBe(0);
  });

  it('marks notifications as read', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId);

    const before = await context.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: player.authHeader,
    });

    expect(before.json().unreadCount).toBe(2);

    const read = await context.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: player.authHeader,
      payload: { ids: [before.json().notifications[0].id] },
    });

    expect(read.statusCode).toBe(204);

    const after = await context.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: player.authHeader,
    });

    expect(after.json().unreadCount).toBe(1);
  });

  it('marks everything as read at once', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId);

    await context.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: player.authHeader,
    });

    const after = await context.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: player.authHeader,
    });

    expect(after.json().unreadCount).toBe(0);
  });

  it('never hands one user another user’s notifications', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId);

    const playerNotifications = await context.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: player.authHeader,
    });

    const stranger = await signIn(context, 'stranger');
    const strangerAttempt = await context.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: stranger.authHeader,
      payload: { ids: [playerNotifications.json().notifications[0].id] },
    });

    expect(strangerAttempt.statusCode).toBe(204);
    expect(
      (
        await context.app.inject({
          method: 'GET',
          url: '/api/v1/notifications',
          headers: player.authHeader,
        })
      ).json().unreadCount,
    ).toBe(2);
  });
});
