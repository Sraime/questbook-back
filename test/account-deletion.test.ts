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
import { createTable, joinTable } from './helpers/tables.js';

describe('deleting an account', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await context.app.close();
    await prisma.$disconnect();
  });

  beforeEach(resetDatabase);

  const deleteAccount = (user: SignedInUser) =>
    context.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/me',
      headers: user.authHeader,
    });

  it('takes the characters and the session with it', async () => {
    const user = await signIn(context, 'alice');

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: user.authHeader,
      payload: characterPayload(),
    });
    expect(created.statusCode).toBe(201);

    const deleted = await deleteAccount(user);
    expect(deleted.statusCode).toBe(204);

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.character.count()).toBe(0);
    expect(await prisma.refreshToken.count()).toBe(0);

    // Le jeton d'acces reste valide quelques minutes apres coup : c'est le
    // compte disparu qui doit le rendre inutilisable, pas son expiration.
    const orphaned = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: user.authHeader,
    });
    expect(orphaned.statusCode).toBe(401);
  });

  it('dissolves the tables the account was running', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    expect(await deleteAccount(gm)).toMatchObject({ statusCode: 204 });

    // Choix produit assume : la table du MJ disparait pour ses joueurs. Sans
    // personne pour l'animer, c'est une salle morte, et rien ici ne sait la
    // transmettre.
    expect(await prisma.gameTable.count()).toBe(0);
    expect(await prisma.tableMember.count()).toBe(0);

    const asPlayer = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tables',
      headers: player.authHeader,
    });
    expect(asPlayer.statusCode).toBe(200);
    expect(asPlayer.json().tables).toEqual([]);
  });

  it('leaves the tables the account had only joined', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    await joinTable(context, gm, player, table.id);

    expect(await deleteAccount(player)).toMatchObject({ statusCode: 204 });

    const asGm = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tables/${table.id}`,
      headers: gm.authHeader,
    });
    expect(asGm.statusCode).toBe(200);
    expect(asGm.json().members).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    const response = await context.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/me',
    });

    expect(response.statusCode).toBe(401);
  });
});
