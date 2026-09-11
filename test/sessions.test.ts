import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  characterPayload,
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

async function createCharacter(
  as: SignedInUser,
  overrides: Record<string, unknown> = {},
) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/characters',
    headers: as.authHeader,
    payload: characterPayload(overrides),
  });

  expect(response.statusCode).toBe(201);
  return response.json();
}

async function answer(
  as: SignedInUser,
  sessionId: string,
  payload: Record<string, unknown>,
) {
  return context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/attendance`,
    headers: as.authHeader,
    payload,
  });
}

async function setCharacter(
  as: SignedInUser,
  sessionId: string,
  characterId: string | null,
) {
  return context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/attendance/character`,
    headers: as.authHeader,
    payload: { characterId },
  });
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

  it('stops calling a session that already happened the next date', async () => {
    const { gm, tableId } = await tableWithPlayer();
    await scheduleSession(gm, tableId, { startsAt: '2020-01-01T19:00:00.000Z' });

    const table = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${tableId}`,
      headers: gm.authHeader,
    });

    expect(table.json().nextSessionAt).toBeNull();
  });

  it('does not let a past session hide the one still ahead', async () => {
    const { gm, tableId } = await tableWithPlayer();
    // Ordered oldest first on purpose: a plain `orderBy` without a cutoff would
    // return this one and the players would never see the real date.
    await scheduleSession(gm, tableId, { startsAt: '2020-01-01T19:00:00.000Z' });
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

  it('refuses an answer from the game master, who runs the session', async () => {
    const { gm, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${session.id}/attendance`,
      headers: gm.authHeader,
      payload: { status: 'yes' },
    });

    expect(response.statusCode).toBe(403);
    expect(await prisma.sessionAttendance.count()).toBe(0);
  });

  it('accepts an answer that already names a character', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player, { name: 'Ernest Blackwood' });

    const response = await answer(player, session.id, {
      status: 'yes',
      characterId: character.id,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().attendances[0].character).toMatchObject({
      id: character.id,
      name: 'Ernest Blackwood',
    });
  });

  it('accepts an answer with no character, then names one later', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);

    const confirmed = await answer(player, session.id, { status: 'yes' });
    expect(confirmed.json().attendances[0].character).toBeNull();

    const named = await setCharacter(player, session.id, character.id);

    expect(named.statusCode).toBe(200);
    expect(named.json().attendances[0].character.id).toBe(character.id);
    expect(await notificationTypes(gm)).toContain('attendance_character_changed');
  });

  it('keeps the character when the answer is sent again without one', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);

    await answer(player, session.id, { status: 'yes', characterId: character.id });
    const again = await answer(player, session.id, { status: 'no' });

    expect(again.json().attendances[0].character.id).toBe(character.id);
  });

  it('detaches the character when asked explicitly', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);

    await answer(player, session.id, { status: 'yes', characterId: character.id });
    const detached = await setCharacter(player, session.id, null);

    expect(detached.statusCode).toBe(200);
    expect(detached.json().attendances[0].character).toBeNull();
  });

  it('refuses a character belonging to someone else', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const someoneElse = await signIn(context, 'stranger');
    const theirs = await createCharacter(someoneElse);

    const response = await answer(player, session.id, {
      status: 'yes',
      characterId: theirs.id,
    });

    expect(response.statusCode).toBe(404);
    expect(await prisma.sessionAttendance.count()).toBe(0);
  });

  it('refuses to name a character before answering at all', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);

    const response = await setCharacter(player, session.id, character.id);

    expect(response.statusCode).toBe(409);
  });

  it('reads a deleted character as no character at all', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);

    await answer(player, session.id, { status: 'yes', characterId: character.id });

    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/characters/${character.id}`,
      headers: player.authHeader,
    });

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
      headers: gm.authHeader,
    });

    // The answer survives its character: the player still said they would come.
    expect(asGm.json().attendances).toHaveLength(1);
    expect(asGm.json().attendances[0].character).toBeNull();
  });

  it('opens a registered character to the others at the table', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);

    await answer(player, session.id, { status: 'yes', characterId: character.id });

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/attendances/${player.userId}/character`,
      headers: gm.authHeader,
    });

    expect(asGm.statusCode).toBe(200);
    expect(asGm.json().name).toBe('Ernest Blackwood');
    // The whole sheet, not just a name: consulting means reading it.
    expect(asGm.json().stats).toHaveLength(2);
    expect(asGm.json().inventory).toHaveLength(1);
  });

  it('keeps a registered character away from outsiders', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);
    await answer(player, session.id, { status: 'yes', characterId: character.id });

    const outsider = await signIn(context, 'outsider');
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/attendances/${player.userId}/character`,
      headers: outsider.authHeader,
    });

    expect(response.statusCode).toBe(404);
  });

  it('says nothing about a player who has not named a character', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    await answer(player, session.id, { status: 'yes' });

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/attendances/${player.userId}/character`,
      headers: gm.authHeader,
    });

    expect(response.statusCode).toBe(404);
  });

  it('still scopes the character module to its owner', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const session = await scheduleSession(gm, tableId);
    const character = await createCharacter(player);
    await answer(player, session.id, { status: 'yes', characterId: character.id });

    // Sharing a session opens the sheet through the session route only; the
    // character endpoints stay private to their owner.
    const direct = await context.app.inject({
      method: 'GET',
      url: `/api/v1/characters/${character.id}`,
      headers: gm.authHeader,
    });

    expect(direct.statusCode).toBe(404);
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

describe('Game master transfer', () => {
  async function transferTo(
    gm: SignedInUser,
    tableId: string,
    memberUserId: string,
  ) {
    return context.app.inject({
      method: 'PUT',
      url: `/api/v1/tables/${tableId}/game-master`,
      headers: gm.authHeader,
      payload: { userId: memberUserId },
    });
  }

  it('swaps the two roles rather than adding a second game master', async () => {
    const { gm, player, tableId } = await tableWithPlayer();

    const response = await transferTo(gm, tableId, player.userId);

    expect(response.statusCode).toBe(200);
    expect(response.json().ownerId).toBe(player.userId);
    // The caller is the outgoing game master, so their own role now reads
    // `player`.
    expect(response.json().role).toBe('player');

    const roles = await prisma.tableMember.findMany({
      where: { tableId },
      select: { userId: true, role: true },
    });
    expect(roles).toHaveLength(2);
    expect(roles.find((r) => r.userId === player.userId)?.role).toBe('gm');
    expect(roles.find((r) => r.userId === gm.userId)?.role).toBe('player');
  });

  it('notifies the new game master', async () => {
    const { gm, player, tableId } = await tableWithPlayer();

    await transferTo(gm, tableId, player.userId);

    expect(await notificationTypes(player)).toContain('game_master_transferred');
  });

  it('drops the new game master out of the sessions still ahead', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const upcoming = await scheduleSession(gm, tableId);
    await answer(player, upcoming.id, { status: 'yes' });

    await transferTo(gm, tableId, player.userId);

    const rows = await prisma.sessionAttendance.findMany({
      where: { sessionId: upcoming.id },
    });
    expect(rows).toEqual([]);
  });

  it('leaves past sessions exactly as they were played', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    const past = await scheduleSession(gm, tableId, {
      startsAt: '2026-01-05T19:00:00.000Z',
    });
    const character = await createCharacter(player);
    await answer(player, past.id, { status: 'yes', characterId: character.id });

    await transferTo(gm, tableId, player.userId);

    // They played that evening, with that character. Becoming game master
    // afterwards does not rewrite it.
    const rows = await prisma.sessionAttendance.findMany({
      where: { sessionId: past.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].characterId).toBe(character.id);
  });

  it('refuses a transfer asked by a player', async () => {
    const { player, tableId } = await tableWithPlayer();

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/v1/tables/${tableId}/game-master`,
      headers: player.authHeader,
      payload: { userId: player.userId },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a transfer to someone who is not at the table', async () => {
    const { gm, tableId } = await tableWithPlayer();
    const outsider = await signIn(context, 'outsider');

    const response = await transferTo(gm, tableId, outsider.userId);

    expect(response.statusCode).toBe(404);
  });

  it('lets the new game master schedule, and the old one answer', async () => {
    const { gm, player, tableId } = await tableWithPlayer();
    await transferTo(gm, tableId, player.userId);

    // Roles really did move: the former player now schedules, and the former
    // game master answers like anyone else.
    const session = await scheduleSession(player, tableId);
    const response = await answer(gm, session.id, { status: 'yes' });

    expect(response.statusCode).toBe(200);
    expect(response.json().myStatus).toBe('yes');
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
