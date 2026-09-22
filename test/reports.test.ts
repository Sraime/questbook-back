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

const report = (as: SignedInUser, payload: Record<string, unknown>) =>
  context.app.inject({
    method: 'POST',
    url: '/api/v1/reports',
    headers: as.authHeader,
    payload,
  });

async function twoPlayersAtATable() {
  const gm = await signIn(context, 'gm');
  const player = await signIn(context, 'player');
  const table = await createTable(context, gm, 'Le cercle de Providence');
  await joinTable(context, gm, player, table.id);

  const session = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${table.id}/sessions`,
    headers: gm.authHeader,
    payload: {
      title: 'Le manoir Corbitt',
      description: 'On y entre, on n’en ressort pas.',
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

/// Assoit un investigateur du joueur à la séance : c'est ce qui le rend
/// visible des autres, et donc signalable.
async function seatInvestigator(
  player: SignedInUser,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/api/v1/characters',
    headers: player.authHeader,
    payload: characterPayload(overrides),
  });
  expect(created.statusCode).toBe(201);
  const characterId = created.json().id as string;

  const seated = await context.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/attendance`,
    headers: player.authHeader,
    payload: { status: 'yes', characterId },
  });
  expect(seated.statusCode).toBe(200);

  return characterId;
}

describe('POST /api/v1/reports', () => {
  it('stores what the content said, not what the caller claims it said', async () => {
    const { gm, player, tableId } = await twoPlayersAtATable();

    const response = await report(player, {
      contentType: 'table',
      contentId: tableId,
      reason: 'Le titre est une insulte à peine déguisée.',
      // Ce que l'appelant raconte de la cible ne doit rien changer.
      snapshot: { Titre: 'Une table parfaitement anodine' },
      reportedUserId: player.userId,
    });

    expect(response.statusCode).toBe(201);

    const stored = await prisma.report.findFirstOrThrow();
    expect(stored.reporterId).toBe(player.userId);
    expect(stored.reportedUserId).toBe(gm.userId);
    expect(JSON.parse(stored.snapshot)).toMatchObject({
      Titre: 'Le cercle de Providence',
    });
  });

  it('keeps the wording even after the author rewrites it', async () => {
    const { gm, player, tableId } = await twoPlayersAtATable();

    await report(player, {
      contentType: 'table',
      contentId: tableId,
      reason: 'Titre choquant.',
    });

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${tableId}`,
      headers: gm.authHeader,
      payload: { title: 'Une table très convenable' },
    });
    expect(renamed.statusCode).toBe(200);

    const stored = await prisma.report.findFirstOrThrow();
    expect(JSON.parse(stored.snapshot).Titre).toBe('Le cercle de Providence');
  });

  it('mails the support with the report', async () => {
    const { player, sessionId } = await twoPlayersAtATable();

    await report(player, {
      contentType: 'session',
      contentId: sessionId,
      reason: 'La description part en vrille.',
    });

    const mail = context.email.lastTo('support@example.com');
    expect(mail?.subject).toBe('Questbook - nouveau signalement');
    expect(mail?.text).toContain('La description part en vrille.');
    expect(mail?.text).toContain('Le manoir Corbitt');
    expect(mail?.text).toContain(player.email);
  });

  it('escapes the hostile text it carries', async () => {
    const { gm, player, tableId } = await twoPlayersAtATable();

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${tableId}`,
      headers: gm.authHeader,
      payload: { title: '<script>alert(1)</script>' },
    });
    expect(renamed.statusCode).toBe(200);

    await report(player, {
      contentType: 'table',
      contentId: tableId,
      reason: '<b>et le motif aussi</b>',
    });

    // Ce mail transporte du texte hostile par construction : c'est même sa
    // raison d'être.
    const html = context.email.lastTo('support@example.com')?.html ?? '';
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;et le motif aussi&lt;/b&gt;');
  });

  it('records the report even when the mail cannot leave', async () => {
    const { player, tableId } = await twoPlayersAtATable();

    // Une panne du fournisseur ne doit pas renvoyer une erreur à quelqu'un
    // qui vient de subir quelque chose : la ligne en base est ce qui compte.
    context.email.send = async () => {
      throw new Error('Resend is down');
    };

    const response = await report(player, {
      contentType: 'table',
      contentId: tableId,
      reason: 'Titre choquant.',
    });

    expect(response.statusCode).toBe(201);
    expect(await prisma.report.count()).toBe(1);
  });

  it('refuses the same report twice', async () => {
    const { player, tableId } = await twoPlayersAtATable();
    const payload = {
      contentType: 'table',
      contentId: tableId,
      reason: 'Titre choquant.',
    };

    expect((await report(player, payload)).statusCode).toBe(201);

    const second = await report(player, payload);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });

  it('lets two different players report the same content', async () => {
    const { gm, player, tableId } = await twoPlayersAtATable();
    const other = await signIn(context, 'other');
    await joinTable(context, gm, other, tableId);

    const payload = {
      contentType: 'table',
      contentId: tableId,
      reason: 'Titre choquant.',
    };

    expect((await report(player, payload)).statusCode).toBe(201);
    expect((await report(other, payload)).statusCode).toBe(201);
    expect(await prisma.report.count()).toBe(2);
  });

  it('refuses to report one’s own content', async () => {
    const { gm, tableId } = await twoPlayersAtATable();

    const response = await report(gm, {
      contentType: 'table',
      contentId: tableId,
      reason: 'Je me déplais.',
    });

    expect(response.statusCode).toBe(400);
  });

  it('reports a player met at a table, by their pseudonym of the day', async () => {
    const { gm, player } = await twoPlayersAtATable();

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: gm.authHeader,
      payload: { displayName: 'Pseudo déplacé' },
    });
    expect(renamed.statusCode).toBe(200);

    const response = await report(player, {
      contentType: 'user',
      contentId: gm.userId,
      reason: 'Ce pseudo est une provocation.',
    });

    expect(response.statusCode).toBe(201);
    const stored = await prisma.report.findFirstOrThrow();
    expect(JSON.parse(stored.snapshot).Pseudo).toBe('Pseudo déplacé');
  });

  it('reports an investigator seated at a shared session', async () => {
    const { gm, player, sessionId } = await twoPlayersAtATable();
    const characterId = await seatInvestigator(player, sessionId, {
      name: 'Ernest Blackwood',
      description: 'Une fiche écrite pour choquer.',
    });

    const response = await report(gm, {
      contentType: 'investigator',
      contentId: characterId,
      reason: 'La description est insoutenable.',
    });

    expect(response.statusCode).toBe(201);
    const stored = await prisma.report.findFirstOrThrow();
    expect(stored.reportedUserId).toBe(player.userId);
    expect(JSON.parse(stored.snapshot)).toMatchObject({
      Nom: 'Ernest Blackwood',
      Description: 'Une fiche écrite pour choquer.',
    });
  });

  it('answers 404 to a stranger rather than admitting the content exists', async () => {
    const { tableId, sessionId, gm } = await twoPlayersAtATable();
    const stranger = await signIn(context, 'stranger');

    for (const payload of [
      { contentType: 'table', contentId: tableId },
      { contentType: 'session', contentId: sessionId },
      { contentType: 'user', contentId: gm.userId },
    ]) {
      const response = await report(stranger, { ...payload, reason: 'Pour voir.' });
      expect(response.statusCode).toBe(404);
    }

    expect(await prisma.report.count()).toBe(0);
  });

  it('hides an investigator who never sat at a shared session', async () => {
    const { gm } = await twoPlayersAtATable();
    const loner = await signIn(context, 'loner');
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: loner.authHeader,
      payload: characterPayload(),
    });
    expect(created.statusCode).toBe(201);

    const response = await report(gm, {
      contentType: 'investigator',
      contentId: created.json().id,
      reason: 'Pour voir.',
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses an empty reason and an unknown content type', async () => {
    const { player, tableId } = await twoPlayersAtATable();

    const blank = await report(player, {
      contentType: 'table',
      contentId: tableId,
      reason: '   ',
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.code).toBe('VALIDATION_ERROR');

    const unknown = await report(player, {
      contentType: 'campagne',
      contentId: tableId,
      reason: 'Pour voir.',
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('turns an anonymous caller away', async () => {
    const { tableId } = await twoPlayersAtATable();

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      payload: { contentType: 'table', contentId: tableId, reason: 'Pour voir.' },
    });

    expect(response.statusCode).toBe(401);
  });
});
