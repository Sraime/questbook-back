import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from './errors.js';

/// Translates everything into `{ "error": { "code", "message" } }`, and answers
/// an unknown route the same way.
///
/// Shared by the product API and the admin API: two copies of this would drift,
/// and a client that has learnt one error shape would meet another.
///
/// > Must be called **before** any route `register`. Fastify freezes the error
/// > handler when each encapsulated context is created, so one installed
/// > afterwards would never fire for routes already registered — a trap already
/// > hit here, three red tests to the name.
export function installErrorHandling(app: FastifyInstance): void {
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

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    }),
  );
}
