import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Env } from './config/env.js';
import { installErrorHandling } from './lib/fastify-errors.js';
import authPlugin from './plugins/auth.js';
import boardLivePlugin from './plugins/board-live.js';
import messagingPlugin from './plugins/messaging.js';
import prismaPlugin from './plugins/prisma.js';
import authRoutes from './modules/auth/auth.routes.js';
import characterRoutes from './modules/characters/character.routes.js';
import deviceRoutes from './modules/notifications/device.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import invitationRoutes from './modules/tables/invitation.routes.js';
import invitationWebRoutes from './modules/tables/invitation-web.routes.js';
import sessionRoutes from './modules/tables/session.routes.js';
import tableRoutes from './modules/tables/table.routes.js';
import scenarioRoutes from './modules/scenarios/scenario.routes.js';
import shopRoutes from './modules/shop/shop.routes.js';
import reportRoutes, { blockRoutes } from './modules/moderation/report.routes.js';
import type { AppleVerifier } from './modules/auth/apple-verifier.js';
import type { GoogleVerifier } from './modules/auth/google-verifier.js';
import type { EmailSender } from './lib/email-sender.js';
import type { PushSender } from './lib/push-sender.js';

export interface BuildAppOptions {
  env: Env;
  /// Test seams: an already-open Prisma client, and stubs for everything that
  /// would otherwise reach the network.
  prismaClient?: PrismaClient;
  googleVerifier?: GoogleVerifier;
  appleVerifier?: AppleVerifier;
  emailSender?: EmailSender;
  pushSender?: PushSender;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Invitation tokens live in the path; never print the raw URL.
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactLoggedUrl(request.url),
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
      // The Google ID token, the Apple identity token, our own tokens and any
      // email in a body must never reach the log files.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.body.idToken',
          'req.body.identityToken',
          'req.body.refreshToken',
          'req.body.email',
          // An invitation token grants table membership to whoever holds it.
          'req.params.token',
        ],
        censor: '[redacted]',
      },
    },
    // OVH sits behind no proxy of ours, but Caddy does terminate TLS in front
    // of the API, so client IPs and the scheme come from X-Forwarded-*.
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Dio, the app's HTTP client, labels every request `application/json` even
  // when it sends no body, and offers no per-request way out. Fastify's stock
  // parser answers that with a 400, which killed every bodyless call —
  // cancelling a session, leaving a table, declining an invitation. Reading it
  // as "no body" costs nothing: routes that need one declare a schema, and an
  // undefined body fails it just as loudly.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body === '') {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(body as string));
      } catch {
        const error = new Error('Request body is not valid JSON') as FastifyError;
        error.statusCode = 400;
        error.code = 'MALFORMED_JSON';
        done(error, undefined);
      }
    },
  );

  // Must come before the route registrations below: each `register` creates an
  // encapsulated context that captures the error handler in place at that
  // moment, so a handler installed afterwards would never fire for them.
  installErrorHandling(app);

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
  });

  await app.register(prismaPlugin, {
    databaseUrl: env.DATABASE_URL,
    client: options.prismaClient,
  });

  await app.register(authPlugin, {
    jwtSecret: env.JWT_SECRET,
    accessTokenTtl: env.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    googleClientIds: env.GOOGLE_CLIENT_IDS,
    appleClientIds: env.APPLE_CLIENT_IDS,
    googleVerifier: options.googleVerifier,
    appleVerifier: options.appleVerifier,
  });

  // Avant les routes : c'est lui qui apprend a Fastify a repondre a une
  // demande de bascule, et une route `websocket: true` declaree sans lui
  // echoue au demarrage.
  await app.register(boardLivePlugin);

  await app.register(messagingPlugin, {
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    firebaseProjectId: env.FIREBASE_PROJECT_ID,
    firebaseClientEmail: env.FIREBASE_CLIENT_EMAIL,
    firebasePrivateKey: env.FIREBASE_PRIVATE_KEY,
    emailSender: options.emailSender,
    pushSender: options.pushSender,
  });

  app.get('/health', async () => {
    await app.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', uptime: process.uptime() };
  });

  const tableOptions = {
    publicBaseUrl: env.PUBLIC_BASE_URL,
    invitationTtlDays: env.INVITATION_TTL_DAYS,
  };

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(characterRoutes, { prefix: '/api/v1/characters' });
  await app.register(tableRoutes, { ...tableOptions, prefix: '/api/v1/tables' });
  await app.register(sessionRoutes, { prefix: '/api/v1/sessions' });
  await app.register(invitationRoutes, {
    ...tableOptions,
    prefix: '/api/v1/invitations',
  });
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  await app.register(deviceRoutes, { prefix: '/api/v1/devices' });
  await app.register(scenarioRoutes, { prefix: '/api/v1/scenarios' });
  await app.register(shopRoutes, { prefix: '/api/v1/shop' });
  await app.register(reportRoutes, {
    reportsEmailTo: env.REPORTS_EMAIL_TO,
    prefix: '/api/v1/reports',
  });
  await app.register(blockRoutes, { prefix: '/api/v1/blocks' });

  // Outside /api/v1 and unauthenticated: this is the link people click in
  // their mail client, and it renders HTML rather than JSON.
  await app.register(invitationWebRoutes, { ...tableOptions, prefix: '/invitations' });

  return app;
}

/// Invitation accept links are unguessable tokens in the path. Echoing the
/// raw URL into logs or 404 bodies would print a credential.
function redactLoggedUrl(url: string): string {
  return url.replace(/(\/invitations\/)[^/?#]+/gi, '$1[redacted]');
}
