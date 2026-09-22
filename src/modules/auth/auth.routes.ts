import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unauthorized } from '../../lib/errors.js';
import { toPublicUser } from './auth.service.js';

const refreshTokenBody = z.object({ refreshToken: z.string().min(1) });

/// A pseudonym is read in lists next to other players', so it is bounded well
/// below the 120 characters a table title may take.
const renameBody = z.object({
  displayName: z.string().trim().min(1).max(60),
});

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /// Sign-up and sign-in in one call: the client sends the Google ID token it
  /// obtained natively, and gets Questbook's own token pair back.
  app.post(
    '/google',
    { schema: { body: z.object({ idToken: z.string().min(1) }) } },
    async (request) => app.auth.signInWithGoogle(request.body.idToken),
  );

  /// Le pendant Apple, exige par la guideline 4.8 des lors que la seule
  /// connexion d'une app est un service tiers. Le nom voyage dans le corps
  /// parce qu'Apple ne le met pas dans le jeton : voir `signInWithApple`.
  app.post(
    '/apple',
    {
      schema: {
        body: z.object({
          identityToken: z.string().min(1),
          displayName: z.string().trim().max(60).optional(),
        }),
      },
    },
    async (request) =>
      app.auth.signInWithApple(request.body.identityToken, request.body.displayName),
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

  app.patch(
    '/me',
    { preHandler: [app.authenticate], schema: { body: renameBody } },
    async (request) => app.auth.rename(request.user.sub, request.body.displayName),
  );

  /// Accepter les conditions d'utilisation. Sans corps : il n'y a rien à
  /// nuancer dans un consentement, et la version acceptée se déduit de la
  /// date — c'est la seule qui était publiée ce jour-là.
  app.post('/terms', { preHandler: [app.authenticate] }, async (request) =>
    app.auth.acceptTerms(request.user.sub),
  );

  app.delete('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    await app.auth.deleteAccount(request.user.sub);
    return reply.code(204).send();
  });
};

export default authRoutes;
