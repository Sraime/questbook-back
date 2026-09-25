import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { currentAdmin } from '../plugins/admin-auth.js';
import { signInSchema } from './admin-auth.schemas.js';

/// Opening and closing a back office session. Nothing creates an account here:
/// `scripts/create-admin.ts` does, on the server, and there is no sign-up to
/// leave open.
const adminAuthRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/session',
    {
      schema: { body: signInSchema },
      // Its own budget, far below the application-wide one. Five failures lock
      // the account anyway; this stops the attempts before they get there, and
      // it covers what no per-account lock ever sees — one password sprayed
      // across many logins.
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const result = await app.adminAuth.signIn(request.body);

      return reply.code(201).send({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        admin: result.admin,
      });
    },
  );

  app.delete('/session', { preHandler: app.requireAdmin }, async (request, reply) => {
    const { admin, sessionId } = currentAdmin(request);
    await app.adminAuth.signOut(sessionId, admin.id);

    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.requireAdmin }, async (request) => currentAdmin(request).admin);
};

export default adminAuthRoutes;
