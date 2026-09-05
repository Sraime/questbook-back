import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unauthorized } from '../../lib/errors.js';
import { toPublicUser } from './auth.service.js';

const refreshTokenBody = z.object({ refreshToken: z.string().min(1) });

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /// Sign-up and sign-in in one call: the client sends the Google ID token it
  /// obtained natively, and gets Questbook's own token pair back.
  app.post(
    '/google',
    { schema: { body: z.object({ idToken: z.string().min(1) }) } },
    async (request) => app.auth.signInWithGoogle(request.body.idToken),
  );

  app.post(
    '/refresh',
    { schema: { body: refreshTokenBody } },
    async (request) => app.auth.refresh(request.body.refreshToken),
  );

  app.post(
    '/logout',
    { schema: { body: refreshTokenBody } },
    async (request, reply) => {
      await app.auth.logout(request.body.refreshToken);
      return reply.code(204).send();
    },
  );

  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const user = await app.auth.findUser(request.user.sub);
    if (!user) {
      // The access token is still cryptographically valid but its account is
      // gone; treat it as a dead session.
      throw unauthorized('Account no longer exists');
    }
    return toPublicUser(user);
  });
};

export default authRoutes;
