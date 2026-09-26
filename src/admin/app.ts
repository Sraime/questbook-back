import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';
import { installErrorHandling } from '../lib/fastify-errors.js';
import prismaPlugin from '../plugins/prisma.js';
import adminAuthPlugin from './plugins/admin-auth.js';
import adminAuthRoutes from './auth/admin-auth.routes.js';
import adminReportRoutes from './reports/admin-report.routes.js';
import adminScenarioRoutes from './scenarios/admin-scenario.routes.js';
import adminUserRoutes from './users/admin-user.routes.js';

export interface BuildAdminAppOptions {
  env: Env;
  /// Test seam: an already-open Prisma client, as in `buildApp`.
  prismaClient?: PrismaClient;
}

/// The back office API.
///
/// It is a second Fastify application rather than a prefix on the product API,
/// because the two have opposite jobs. Every route of the product API keeps an
/// account inside its own data; every route here reads across all of them —
/// emails, table titles, investigator sheets. Sharing a listener would mean
/// sharing a surface, and one bad route would put the whole catalogue of
/// personal data one authentication bug away.
///
/// They do share a repository, a Prisma schema and a Docker image on purpose:
/// two copies of the model always drift, and this project already has a rule
/// about the day the app shipped ahead of its backend.
///
/// **Nothing here is reachable from the internet.** The container publishes on
/// the VPS loopback only (see `docker-compose.yml`), Caddy knows nothing about
/// it, and an SSH tunnel is the single way in. Authentication lands in the next
/// card; until then the closed door is the whole defence, which is exactly why
/// this application ships with no business route at all.
export async function buildAdminApp(
  options: BuildAdminAppOptions,
): Promise<FastifyInstance> {
  const { env } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        // Nothing that authenticates an administrator may reach the log files.
        // The one-time code is listed too: it is useless thirty seconds later,
        // but a log that prints it prints the pattern of the secret behind it.
        paths: [
          'req.headers.authorization',
          'req.body.password',
          'req.body.totp',
        ],
        censor: '[redacted]',
      },
    },
    // Unlike the product API, nothing terminates TLS in front of this one: the
    // tunnel hands the request straight to the container, so `X-Forwarded-For`
    // could only ever be something a caller made up.
    trustProxy: false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Before the routes, for the reason spelled out in `installErrorHandling`.
  installErrorHandling(app);

  // No `@fastify/cors`, and that is a decision rather than an omission: the
  // local front reaches this API through its dev server's proxy, so the
  // browser only ever talks to its own origin. There is no origin to allow,
  // and allowing one would be the first hole in an otherwise closed door.
  //
  // No empty-body JSON parser either. That one exists in `app.ts` to humour
  // Dio, which stamps `application/json` on bodyless requests; `fetch` does
  // not, so Fastify's stock parser is correct here.
  await app.register(helmet, { contentSecurityPolicy: false });

  // A single human behind a tunnel never needs more than a couple of requests
  // per second. The login route gets its own, far tighter budget in the card
  // that introduces it — this one only keeps a runaway front from hammering.
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  await app.register(prismaPlugin, {
    databaseUrl: env.DATABASE_URL,
    client: options.prismaClient,
  });

  await app.register(adminAuthPlugin);

  // Outside `/admin`, like the product API keeps `/health` outside `/api/v1`:
  // Docker polls it, and it says nothing a caller could not guess.
  app.get('/health', async () => {
    await app.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', uptime: process.uptime() };
  });

  // Routes live under `/admin` so the front proxies one prefix and the logs
  // say which API answered. No `/v1`: this API and its front ship from the
  // same repository, in the same breath, and never need to disagree.
  await app.register(adminAuthRoutes, { prefix: '/admin/auth' });
  await app.register(adminReportRoutes, { prefix: '/admin/reports' });
  await app.register(adminUserRoutes, { prefix: '/admin/users' });
  await app.register(adminScenarioRoutes, { prefix: '/admin/scenarios' });

  return app;
}
