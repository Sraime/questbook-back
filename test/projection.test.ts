import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { hashToken } from '../src/lib/tokens.js';
import { publicBoard } from '../src/modules/projection/projection.board.js';
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

afterEach(async () => {
  await context.app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const hour = 60 * 60 * 1000;

/// Une seance commencee depuis une heure : la projection est ouverte.
async function runningSession() {
  const gm = await signIn(context, 'gm');
  const player = await signIn(context, 'player');
  const table = await createTable(context, gm);
  await joinTable(context, gm, player, table.id);

  const created = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${table.id}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Le manoir Corbitt',
      startsAt: new Date(Date.now() + hour).toISOString(),
      location: 'Chez Robin',
    },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = created.json().id as string;

  await startsIn(sessionId, -hour);
  return { gm, player, sessionId };
}

const startsIn = (sessionId: string, ms: number) =>
  prisma.gameSession.update({
    where: { id: sessionId },
    data: { startsAt: new Date(Date.now() + ms) },
  });

const createLink = (as: SignedInUser, sessionId: string) =>
  context.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/projection`,
    headers: as.authHeader,
  });

async function linkFor(gm: SignedInUser, sessionId: string): Promise<string> {
  const response = await createLink(gm, sessionId);
  expect(response.statusCode).toBe(201);
  return new URL(response.json().url).pathname.split('/')[2];
}

const openPage = (token: string) =>
  context.app.inject({ method: 'GET', url: `/projection/${token}` });

const pushBoard = (as: SignedInUser, sessionId: string, tokens: unknown[], mapId = 'manoir') =>
  context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/board`,
    headers: as.authHeader,
    payload: { tokens: JSON.stringify(tokens), mapId },
  });

/// Un pion lie a son personnage, comme l'app en ecrit : c'est ce lien que la
/// page publique ne doit jamais recevoir.
const linkedToken = {
  id: 'tok-1',
  kind: 'character',
  color: 'blue',
  x: 0.4,
  y: 0.6,
  size: 0.08,
  assetKey: 'grand_ancien',
  character: { type: 'investigator', id: 'char-secret', userId: 'user-secret' },
};

describe('projection link, game master side', () => {
  it('gives the game master a public link, and stores only its hash', async () => {
    const { gm, sessionId } = await runningSession();

    const response = await createLink(gm, sessionId);

    expect(response.statusCode).toBe(201);
    const { url, opensAt, closesAt } = response.json();
    expect(url).toMatch(/^http:\/\/localhost:3000\/projection\/[A-Za-z0-9_-]{40,}$/);
    expect(new Date(closesAt).getTime() - new Date(opensAt).getTime()).toBe(24 * hour);

    const token = new URL(url).pathname.split('/')[2];
    const row = await prisma.gameSession.findUnique({ where: { id: sessionId } });
    expect(row?.projectionTokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('refuses a player, and anyone signed out', async () => {
    const { player, sessionId } = await runningSession();

    expect((await createLink(player, sessionId)).statusCode).toBe(403);
    const anonymous = await context.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/projection`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses a session that is over or cancelled', async () => {
    const { gm, sessionId } = await runningSession();

    await startsIn(sessionId, -25 * hour);
    expect((await createLink(gm, sessionId)).statusCode).toBe(409);

    await startsIn(sessionId, hour);
    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}`,
      headers: gm.authHeader,
    });
    expect((await createLink(gm, sessionId)).statusCode).toBe(409);
  });

  it('revokes the previous link when a new one is made', async () => {
    const { gm, sessionId } = await runningSession();
    const first = await linkFor(gm, sessionId);
    const second = await linkFor(gm, sessionId);

    expect((await openPage(first)).statusCode).toBe(404);
    expect((await openPage(second)).statusCode).toBe(200);
  });

  it('stops the projection on demand, and says so to the game master', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    const status = () =>
      context.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/projection`,
        headers: gm.authHeader,
      });
    expect((await status()).json()).toEqual({ active: true });

    const stopped = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}/projection`,
      headers: gm.authHeader,
    });

    expect(stopped.statusCode).toBe(204);
    expect((await status()).json()).toEqual({ active: false });
    expect((await openPage(token)).statusCode).toBe(404);
  });
});

describe('projection page, public side', () => {
  it('opens without an account while the session runs, behind a strict policy', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    const page = await openPage(token);

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Le manoir Corbitt');
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('only opens between the start of the session and its closing', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    await startsIn(sessionId, 2 * hour);
    const early = await openPage(token);
    expect(early.statusCode).toBe(403);
    expect(early.body).toContain('ouvrira au début de la séance');

    await startsIn(sessionId, -24 * hour - 1000);
    const late = await openPage(token);
    expect(late.statusCode).toBe(410);
    expect(late.body).toContain('terminée');
  });

  it('answers 404 to an unknown link, and to a cancelled session', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    expect((await openPage('x'.repeat(43))).statusCode).toBe(404);

    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}`,
      headers: gm.authHeader,
    });
    expect((await openPage(token)).statusCode).toBe(404);
  });

  it('escapes the session title in the page', async () => {
    const { gm, sessionId } = await runningSession();
    await prisma.gameSession.update({
      where: { id: sessionId },
      data: { title: '<script>alert(1)</script>' },
    });
    const token = await linkFor(gm, sessionId);

    const page = await openPage(token);

    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&lt;script&gt;');
  });

  it('serves hosted assets and their pictures to a valid link only', async () => {
    const { gm, sessionId } = await runningSession();
    await prisma.asset.create({
      data: {
        key: 'carte_crypte',
        name: 'La crypte',
        kind: 'map',
        image: Buffer.from('png-bytes'),
        imageType: 'image/png',
        imageHash: 'hash-1',
        width: 800,
        height: 600,
      },
    });
    const token = await linkFor(gm, sessionId);

    const list = await context.app.inject({ method: 'GET', url: `/projection/${token}/assets` });
    expect(list.statusCode).toBe(200);
    expect(list.json().assets).toEqual([
      expect.objectContaining({ key: 'carte_crypte', kind: 'map', width: 800, height: 600 }),
    ]);

    const image = await context.app.inject({
      method: 'GET',
      url: `/projection/${token}/assets/carte_crypte/image`,
    });
    expect(image.statusCode).toBe(200);
    expect(image.body).toBe('png-bytes');

    const stranger = await context.app.inject({
      method: 'GET',
      url: `/projection/${'y'.repeat(43)}/assets/carte_crypte/image`,
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('has no way to write anything', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const path of ['', '/live', '/board', '/assets']) {
        const response = await context.app.inject({
          method,
          url: `/projection/${token}${path}`,
          payload: { tokens: '[]', mapId: 'grille' },
        });
        expect(response.statusCode, `${method} ${path}`).toBe(404);
      }
    }

    const board = await prisma.sessionBoard.findUnique({ where: { sessionId } });
    expect(board).toBeNull();
  });

  it('serves its own static files, and nothing else from the disk', async () => {
    const script = await context.app.inject({
      method: 'GET',
      url: '/projection/static/projection.js',
    });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');

    for (const file of ['..%2F..%2Fpackage.json', '.env', 'unknown.js']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/projection/static/${file}`,
      });
      expect(response.statusCode, file).toBe(404);
    }
  });
});

describe('projection board', () => {
  it('keeps only what the screen draws, never the link to a character', () => {
    const board = publicBoard({
      sessionId: 's',
      tokens: JSON.stringify([
        linkedToken,
        { id: 'tok-2', kind: 'zone_disc', color: 'yellow', x: 0.1, y: 0.2, notes: 'piege' },
        { kind: 'character', x: 0.1, y: 0.1 },
        'garbage',
      ]),
      mapId: 'grille',
      revision: 3,
      updatedAt: new Date().toISOString(),
    });

    expect(board).toEqual({
      mapId: 'grille',
      revision: 3,
      tokens: [
        {
          id: 'tok-1',
          kind: 'character',
          color: 'blue',
          x: 0.4,
          y: 0.6,
          size: 0.08,
          assetKey: 'grand_ancien',
        },
        { id: 'tok-2', kind: 'zone_disc', color: 'yellow', x: 0.1, y: 0.2, size: 0.07 },
      ],
    });
  });

  it('survives a board that is not JSON', () => {
    const board = publicBoard({
      sessionId: 's',
      tokens: 'not json',
      mapId: null,
      revision: 1,
      updatedAt: new Date().toISOString(),
    });
    expect(board.tokens).toEqual([]);
  });
});

describe('projection, live', () => {
  async function listen(): Promise<string> {
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const address = context.app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  function nextMessage(socket: WebSocket, label = 'a message'): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Waited for ${label}, nothing came`)),
        5000,
      );
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  const closed = (socket: WebSocket) =>
    new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

  it('sends the cleaned board, then every move of the game master', async () => {
    const { gm, sessionId } = await runningSession();
    await pushBoard(gm, sessionId, [linkedToken]);
    const token = await linkFor(gm, sessionId);

    const base = await listen();
    const socket = new WebSocket(`${base}/projection/${token}/live`);

    const first = await nextMessage(socket, 'the board');
    expect(first).toMatchObject({ type: 'board', board: { mapId: 'manoir', revision: 1 } });
    expect(JSON.stringify(first)).not.toContain('secret');

    const moved = nextMessage(socket, 'the move');
    await pushBoard(gm, sessionId, [{ ...linkedToken, x: 0.9 }], 'grille');
    const second = await moved;
    expect(second).toMatchObject({
      type: 'board',
      board: { mapId: 'grille', revision: 2, tokens: [{ id: 'tok-1', x: 0.9 }] },
    });
    expect(JSON.stringify(second)).not.toContain('secret');

    socket.close();
    await closed(socket);
  });

  it('hangs up on a screen that tries to send anything', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    const base = await listen();
    const socket = new WebSocket(`${base}/projection/${token}/live`);
    await nextMessage(socket);

    const hungUp = closed(socket);
    socket.send(JSON.stringify({ tokens: '[]', mapId: 'grille' }));

    expect(await hungUp).toBe(1008);
    const board = await prisma.sessionBoard.findUnique({ where: { sessionId } });
    expect(board).toBeNull();
    expect(context.app.boardLive.projections(sessionId)).toBe(0);
  });

  it('turns open screens off when the game master stops or replaces the link', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);

    const base = await listen();
    const socket = new WebSocket(`${base}/projection/${token}/live`);
    await nextMessage(socket);

    const notice = nextMessage(socket, 'the closing notice');
    const hungUp = closed(socket);
    await linkFor(gm, sessionId);

    expect(await notice).toMatchObject({ type: 'closed' });
    await hungUp;
    expect(context.app.boardLive.projections(sessionId)).toBe(0);
  });

  it('refuses a link that does not open anything now', async () => {
    const { gm, sessionId } = await runningSession();
    const token = await linkFor(gm, sessionId);
    await startsIn(sessionId, -25 * hour);

    const base = await listen();
    const socket = new WebSocket(`${base}/projection/${token}/live`);

    expect(await nextMessage(socket)).toMatchObject({ type: 'error', status: 410 });
    await closed(socket);
  });
});
