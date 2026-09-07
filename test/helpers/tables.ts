import { expect } from 'vitest';
import type { SignedInUser, TestContext } from './test-app.js';

export async function createTable(
  context: TestContext,
  owner: SignedInUser,
  title = 'Les Inspecteurs Chavillois',
) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/tables',
    headers: owner.authHeader,
    payload: { title, universeLabel: 'L’Appel de Cthulhu' },
  });

  expect(response.statusCode).toBe(201);
  return response.json();
}

/// Invites `player` and digs the raw token back out of the email body, which
/// is the only place it ever exists in clear.
export async function invite(
  context: TestContext,
  gm: SignedInUser,
  tableId: string,
  email: string,
): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${tableId}/invitations`,
    headers: gm.authHeader,
    payload: { email },
  });

  expect(response.statusCode).toBe(201);

  const body = context.email.lastTo(email)?.text ?? '';
  const token = /\/invitations\/([\w-]+)/.exec(body)?.[1];
  if (!token) {
    throw new Error(`No invitation link found in the email to ${email}`);
  }
  return token;
}

export async function joinTable(
  context: TestContext,
  gm: SignedInUser,
  player: SignedInUser,
  tableId: string,
): Promise<void> {
  const token = await invite(context, gm, tableId, player.email);
  const response = await context.app.inject({
    method: 'POST',
    url: `/invitations/${token}/accept`,
  });
  expect(response.statusCode).toBe(200);
}
