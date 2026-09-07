import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { unauthorized } from '../../src/lib/errors.js';
import type { EmailMessage, EmailSender } from '../../src/lib/email-sender.js';
import type {
  PushMessage,
  PushResult,
  PushSender,
} from '../../src/lib/push-sender.js';
import type {
  GoogleIdentity,
  GoogleVerifier,
} from '../../src/modules/auth/google-verifier.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'Set TEST_DATABASE_URL (or DATABASE_URL) to a PostgreSQL database dedicated to tests — its tables are truncated between tests.',
  );
}

export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

/// Stands in for Google's token endpoint: an "ID token" is simply a key into a
/// map of identities the test registered beforehand.
export class FakeGoogleVerifier implements GoogleVerifier {
  private readonly identities = new Map<string, GoogleIdentity>();

  register(idToken: string, identity: Partial<GoogleIdentity> & { sub: string }): void {
    this.identities.set(idToken, {
      email: `${identity.sub}@example.com`,
      emailVerified: true,
      displayName: 'Test User',
      pictureUrl: null,
      locale: 'fr',
      ...identity,
    });
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const identity = this.identities.get(idToken);
    if (!identity) {
      throw unauthorized('Invalid Google ID token');
    }
    return identity;
  }
}

/// Records what would have been sent so a test can assert on the recipient and
/// pull the invitation link out of the body.
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(email: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === email);
  }
}

export class FakePushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  /// Tokens to report back as dead, to exercise the pruning path.
  staleTokens: string[] = [];

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    return {
      staleTokens: message.tokens.filter((token) => this.staleTokens.includes(token)),
    };
  }
}

export interface TestContext {
  app: FastifyInstance;
  google: FakeGoogleVerifier;
  email: FakeEmailSender;
  push: FakePushSender;
}

export async function createTestApp(): Promise<TestContext> {
  const google = new FakeGoogleVerifier();
  const email = new FakeEmailSender();
  const push = new FakePushSender();

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'test-jwt-secret-long-enough-for-hs256-signing',
    GOOGLE_CLIENT_IDS: 'test-client-id.apps.googleusercontent.com',
    LOG_LEVEL: 'silent',
    // The suite fires far more requests per minute than a real client would.
    RATE_LIMIT_MAX: '100000',
  } as NodeJS.ProcessEnv);

  const app = await buildApp({
    env,
    prismaClient: prisma,
    googleVerifier: google,
    emailSender: email,
    pushSender: push,
  });
  await app.ready();

  return { app, google, email, push };
}

/// Cascades from `users` reach characters and their children, and every table
/// added below. Listing them all anyway keeps the reset honest if a future
/// model ever stops cascading from a user.
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, characters, character_stats, character_resources, inventory_items, refresh_tokens, game_tables, table_members, table_invitations, game_sessions, session_attendances, device_tokens, notifications RESTART IDENTITY CASCADE',
  );
}

export interface SignedInUser {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  authHeader: { authorization: string };
}

export async function signIn(
  context: TestContext,
  sub = 'google-sub-1',
): Promise<SignedInUser> {
  const idToken = `id-token-${sub}`;
  context.google.register(idToken, { sub });

  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/auth/google',
    payload: { idToken },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Sign-in failed: ${response.statusCode} ${response.body}`);
  }

  const body = response.json();
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    email: body.user.email,
    authHeader: { authorization: `Bearer ${body.accessToken}` },
  };
}

/// A minimal but complete aggregate, shaped exactly like what the Flutter
/// client pushes.
export function characterPayload(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    systemId: 'call_of_cthulhu_classique',
    name: 'Ernest Blackwood',
    occupation: 'Antiquaire',
    description: null,
    level: 1,
    createdAt: now,
    updatedAt: now,
    stats: [
      {
        kind: 'characteristic',
        key: 'FOR',
        label: 'Force',
        value: 55,
        base: null,
        sortOrder: 0,
      },
      {
        kind: 'skill',
        key: 'bibliotheque',
        label: 'Bibliothèque',
        value: 20,
        base: 'INT/2',
        sortOrder: 1,
      },
    ],
    resources: [
      { key: 'pv', label: 'Points de vie', current: 11, max: 11, tone: 'danger' },
    ],
    inventory: [{ name: 'Lampe torche', qty: 1, weight: '0,5 kg' }],
    ...overrides,
  };
}
