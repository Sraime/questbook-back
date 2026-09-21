import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
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

/// Seul fichier de la suite a ouvrir un vrai port, donc seul a devoir le
/// rendre : un serveur laisse en ecoute par chaque test finirait par en tenir
/// une centaine. La fermeture epargne le client Prisma, que la suite partage.
afterEach(async () => {
  await context.app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/// Le suffixe sert aux tests qui font jouer deux tables en meme temps : sans
/// lui, deux appels signeraient le meme `gm` et le meme `player`, et une fuite
/// d'une soiree a l'autre passerait pour un acces legitime.
async function tableWithSession(suffix = '') {
  const gm = await signIn(context, `gm${suffix}`);
  const player = await signIn(context, `player${suffix}`);
  const table = await createTable(context, gm);
  await joinTable(context, gm, player, table.id);

  const session = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${table.id}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Le manoir Corbitt',
      startsAt: '2026-10-12T19:00:00.000Z',
      location: 'Chez Robin',
    },
  });
  expect(session.statusCode).toBe(201);

  return {
    gm,
    player,
    tableId: table.id as string,
    sessionId: session.json().id as string,
  };
}

const oneToken = JSON.stringify([
  { id: 'tok-1', kind: 'character', color: 'red', x: 0.2, y: 0.3, size: 0.07 },
]);

const twoTokens = JSON.stringify([
  { id: 'tok-1', kind: 'character', color: 'red', x: 0.5, y: 0.3, size: 0.07 },
  { id: 'tok-2', kind: 'zone_disc', color: 'blue', x: 0.8, y: 0.1, size: 0.2 },
]);

const readBoard = (as: SignedInUser, sessionId: string) =>
  context.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${sessionId}/board`,
    headers: as.authHeader,
  });

const pushBoard = (
  as: SignedInUser,
  sessionId: string,
  payload: Record<string, unknown>,
) =>
  context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/board`,
    headers: as.authHeader,
    payload,
  });

describe('session board', () => {
  it('requires a signed-in caller', async () => {
    const { sessionId } = await tableWithSession();

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/board`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers an empty board rather than 404 before anything is placed',
    async () => {
      // La session existe, et un joueur peut l'ouvrir avant que le MJ ait
      // pose quoi que ce soit. Lui dire « introuvable » ressemblerait a une
      // panne la ou il n'y a encore rien.
      const { player, sessionId } = await tableWithSession();

      const response = await readBoard(player, sessionId);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        sessionId,
        tokens: '[]',
        mapId: null,
        revision: 0,
      });
    });

  it('lets every member read what the game master pushed', async () => {
    // L'inverse des PNJ, dont la lecture est reservee au MJ : un plateau est
    // fait pour etre vu.
    const { gm, player, sessionId } = await tableWithSession();

    const pushed = await pushBoard(gm, sessionId, {
      tokens: oneToken,
      mapId: 'manoir',
    });
    expect(pushed.statusCode).toBe(200);

    const seen = await readBoard(player, sessionId);

    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({
      tokens: oneToken,
      mapId: 'manoir',
      revision: 1,
    });
  });

  it('refuses a player who tries to move a pawn', async () => {
    const { player, sessionId } = await tableWithSession();

    const response = await pushBoard(player, sessionId, { tokens: oneToken });

    expect(response.statusCode).toBe(403);
    expect(await prisma.sessionBoard.count()).toBe(0);
  });

  it('hides the session entirely from a stranger', async () => {
    // 404 et non 403, comme partout ailleurs : un appelant ne doit pas
    // pouvoir sonder quels identifiants existent.
    const { sessionId } = await tableWithSession();
    const stranger = await signIn(context, 'stranger');

    expect((await readBoard(stranger, sessionId)).statusCode).toBe(404);
    expect((await pushBoard(stranger, sessionId, { tokens: oneToken })).statusCode)
      .toBe(404);
  });

  it('replaces the board whole and climbs one revision at a time', async () => {
    // Un seul compte ecrit, donc la derniere poussee gagne et il n'y a rien a
    // reconcilier. L'appareil detient la verite complete.
    const { gm, sessionId } = await tableWithSession();

    const first = await pushBoard(gm, sessionId, { tokens: twoTokens });
    expect(first.json().revision).toBe(1);

    const second = await pushBoard(gm, sessionId, { tokens: oneToken });
    expect(second.json().revision).toBe(2);
    expect(second.json().tokens).toBe(oneToken);

    // Retirer la carte est un geste comme un autre : le champ absent la
    // remet a zero plutot que de garder l'ancienne.
    expect(second.json().mapId).toBeNull();
  });

  it('keeps the pawns opaque and only checks they are a list', async () => {
    // Connaitre la forme d'un pion est le travail du client : un serveur qui
    // la validait devrait etre mis a jour avant qu'un nouveau type de pion
    // puisse etre pose.
    const { gm, sessionId } = await tableWithSession();

    const unknownKind = JSON.stringify([
      { id: 'tok-9', kind: 'quelque-chose-de-2027', mystere: true },
    ]);
    expect((await pushBoard(gm, sessionId, { tokens: unknownKind })).statusCode)
      .toBe(200);

    expect((await pushBoard(gm, sessionId, { tokens: 'pas du json' })).statusCode)
      .toBe(400);
    expect((await pushBoard(gm, sessionId, { tokens: '{"x":1}' })).statusCode)
      .toBe(400);
  });

  it('drops the board with its session', async () => {
    const { gm, tableId, sessionId } = await tableWithSession();
    await pushBoard(gm, sessionId, { tokens: oneToken });

    await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/tables/${tableId}`,
      headers: gm.authHeader,
    });

    expect(await prisma.sessionBoard.count()).toBe(0);
  });
});

describe('session board, live', () => {
  /// Un vrai socket, sur un vrai port : `inject` ne sait pas basculer en
  /// WebSocket, et une doublure ne dirait rien de la poignee de main ni de
  /// l'autorisation qui s'y joue.
  async function listen(): Promise<string> {
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const address = context.app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  function connect(base: string, sessionId: string, as: SignedInUser) {
    return new WebSocket(`${base}/api/v1/sessions/${sessionId}/board/live`, {
      headers: as.authHeader,
    });
  }

  /// Le prochain message, ou un echec au bout de cinq secondes : une attente
  /// sans borne ferait pendre la suite au lieu de la faire echouer. La borne
  /// etait de deux secondes, et une passe a froid la depassait sur le test
  /// qui monte deux tables avant d'ouvrir son premier socket.
  function nextMessage(
    socket: WebSocket,
    label = 'a message',
  ): Promise<Record<string, unknown>> {
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
    new Promise<void>((resolve) => socket.once('close', () => resolve()));

  /// L'inverse de `nextMessage` : tout ce qu'un socket a dit, pour qu'une
  /// isolation se lise comme une liste vide. Un `nextMessage` qui expire
  /// dirait la meme chose, mais il ferait dependre le verdict de la vitesse
  /// de la machine — c'est ainsi qu'on ecrit un test qui passe parce qu'il
  /// n'a pas attendu assez.
  function everythingHeard(socket: WebSocket): string[] {
    const heard: string[] = [];
    socket.on('message', (data) => heard.push(data.toString()));
    return heard;
  }

  it('sends the whole board on connection, before anything moves', async () => {
    // Sans ce premier message, le joueur devrait aussi appeler `GET` et
    // verrait un plateau vide jusqu'au geste suivant du MJ.
    const { gm, player, sessionId } = await tableWithSession();
    await pushBoard(gm, sessionId, { tokens: oneToken, mapId: 'manoir' });

    const base = await listen();
    const socket = connect(base, sessionId, player);

    const message = await nextMessage(socket);

    expect(message).toMatchObject({
      type: 'board',
      board: { tokens: oneToken, mapId: 'manoir', revision: 1 },
    });

    socket.close();
    await closed(socket);
  });

  it('pushes the game master’s move to a watching player', async () => {
    const { gm, player, sessionId } = await tableWithSession();

    const base = await listen();
    const socket = connect(base, sessionId, player);
    await nextMessage(socket);

    const moved = nextMessage(socket);
    await pushBoard(gm, sessionId, { tokens: twoTokens, mapId: 'grille' });

    expect(await moved).toMatchObject({
      type: 'board',
      board: { tokens: twoTokens, mapId: 'grille', revision: 1 },
    });

    socket.close();
    await closed(socket);
  });

  it('turns a stranger away instead of letting them listen', async () => {
    const { sessionId } = await tableWithSession();
    const stranger = await signIn(context, 'stranger');

    const base = await listen();
    const socket = connect(base, sessionId, stranger);

    const message = await nextMessage(socket);
    expect(message.type).toBe('error');

    await closed(socket);
    expect(context.app.boardLive.listeners(sessionId)).toBe(0);
  });

  it('refuses a listener without a token', async () => {
    const { sessionId } = await tableWithSession();
    const base = await listen();

    const socket = new WebSocket(
      `${base}/api/v1/sessions/${sessionId}/board/live`,
    );

    await expect(nextMessage(socket)).rejects.toThrow();
    expect(context.app.boardLive.listeners(sessionId)).toBe(0);
  });

  it('forgets a listener who hangs up', async () => {
    // Une salle vide qu'on ne nettoie pas garderait un identifiant de session
    // pour chaque soiree jamais jouee.
    const { player, sessionId } = await tableWithSession();

    const base = await listen();
    const socket = connect(base, sessionId, player);
    await nextMessage(socket);

    expect(context.app.boardLive.listeners(sessionId)).toBe(1);

    socket.close();
    await closed(socket);
    // La fermeture du socket precede de peu celle vue par le serveur.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(context.app.boardLive.listeners(sessionId)).toBe(0);
  });

  it('keeps two tables playing the same evening apart', async () => {
    // Deux soirees partagent un processus et une seule `BoardLiveRegistry`.
    // Le jour ou la cle d'une salle serait recalculee ailleurs, rien a l'ecran
    // ne le dirait : c'est ce test qui doit le dire.
    const providence = await tableWithSession('-providence');
    const arkham = await tableWithSession('-arkham');

    const base = await listen();
    const watchingProvidence = connect(
      base,
      providence.sessionId,
      providence.player,
    );
    const watchingArkham = connect(base, arkham.sessionId, arkham.player);

    // Le plateau d'ouverture, celui que chacun recoit pour lui-meme. Les deux
    // attentes sont armees avant d'en attendre une seule : le plateau d'Arkham
    // arrive parfois pendant qu'on attend celui de Providence, et un `ws` sans
    // ecoutant a cet instant jette l'evenement. C'est ce qui rendait ce test
    // capricieux — il attendait ensuite un second message qui ne venait jamais.
    const providenceOpening = nextMessage(
      watchingProvidence,
      'Providence’s own board',
    );
    const arkhamOpening = nextMessage(watchingArkham, 'Arkham’s own board');
    await providenceOpening;
    await arkhamOpening;

    const heardInArkham = everythingHeard(watchingArkham);
    const moved = nextMessage(watchingProvidence, 'the move in Providence');
    await pushBoard(providence.gm, providence.sessionId, {
      tokens: twoTokens,
      mapId: 'manoir',
    });

    expect(await moved).toMatchObject({
      type: 'board',
      board: { tokens: twoTokens, mapId: 'manoir' },
    });

    // L'attente part de la reception ci-dessus, et non de la poussee : une
    // fuite serait deja distribuee, il ne lui reste qu'a traverser la boucle
    // d'evenements. Verifie en cassant l'isolation exprès — sans ce sursis,
    // le test passait quand meme, le message fuite arrivant un tour trop tard.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heardInArkham).toEqual([]);
    // Et ce vide doit venir de l'isolation, pas d'un socket mort.
    expect(watchingArkham.readyState).toBe(WebSocket.OPEN);

    watchingProvidence.close();
    watchingArkham.close();
    await Promise.all([closed(watchingProvidence), closed(watchingArkham)]);
  });

  it('empties one room without touching the other', async () => {
    const providence = await tableWithSession('-providence');
    const arkham = await tableWithSession('-arkham');

    const base = await listen();
    const leaving = connect(base, providence.sessionId, providence.player);
    const staying = connect(base, arkham.sessionId, arkham.player);
    // Les deux attentes d'abord, pour la raison dite au test precedent.
    const opened = Promise.all([
      nextMessage(leaving, 'the board of the one who leaves'),
      nextMessage(staying, 'the board of the one who stays'),
    ]);
    await opened;

    expect(context.app.boardLive.listeners(providence.sessionId)).toBe(1);
    expect(context.app.boardLive.listeners(arkham.sessionId)).toBe(1);

    leaving.close();
    await closed(leaving);
    // La fermeture du socket precede de peu celle vue par le serveur.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(context.app.boardLive.listeners(providence.sessionId)).toBe(0);
    expect(context.app.boardLive.listeners(arkham.sessionId)).toBe(1);

    staying.close();
    await closed(staying);
  });

  it('leaves a board pushed while nobody listens perfectly readable',
    async () => {
      // Le canal est un confort, pas le moyen de conserver le plateau : la
      // base garde tout, et qui se connecte ensuite recoit l'etat entier.
      const { gm, player, sessionId } = await tableWithSession();

      await pushBoard(gm, sessionId, { tokens: twoTokens });

      const base = await listen();
      const socket = connect(base, sessionId, player);

      expect(await nextMessage(socket)).toMatchObject({
        board: { tokens: twoTokens, revision: 1 },
      });

      socket.close();
      await closed(socket);
    });
});
