import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Env } from './config/env.js';
import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import prismaPlugin from './plugins/prisma.js';
import authRoutes from './modules/auth/auth.routes.js';
import characterRoutes from './modules/characters/character.routes.js';
import type { GoogleVerifier } from './modules/auth/google-verifier.js';

export interface BuildAppOptions {
  env: Env;
  /// Test seams: an already-open Prisma client and a stubbed Google verifier.
  prismaClient?: PrismaClient;
  googleVerifier?: GoogleVerifier;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // The Google ID token and our own tokens must never reach the log files.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.body.idToken',
          'req.body.refreshToken',
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

  // Must come before the route registrations below: each `register` creates an
  // encapsulated context that captures the error handler in place at that
  // moment, so a handler installed afterwards would never fire for them.
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request payload is invalid' },
        issues: error.validation,
      });
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }

    // Fastify's own errors (rate limit, malformed JSON, ...) already carry a
    // usable status; the type guards above widen `error` to unknown.
    const fastifyError = error as FastifyError;
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? 'REQUEST_ERROR',
          message: fastifyError.message,
        },
      });
    }

    // Unexpected: log the real cause, tell the client nothing.
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    }),
  );

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
    googleVerifier: options.googleVerifier,
  });

  app.get('/health', async () => {
    await app.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', uptime: process.uptime() };
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(characterRoutes, { prefix: '/api/v1/characters' });

  return app;
}
