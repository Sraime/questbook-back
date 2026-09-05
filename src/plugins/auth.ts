import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { unauthorized } from '../lib/errors.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { createGoogleVerifier } from '../modules/auth/google-verifier.js';
import type { GoogleVerifier } from '../modules/auth/google-verifier.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthService;
    /// `preHandler` guard: rejects the request unless it carries a valid
    /// `Authorization: Bearer <access token>` header.
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  jwtSecret: string;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  googleClientIds: string[];
  /// Test seam: lets integration tests bypass real Google token verification.
  googleVerifier?: GoogleVerifier;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  await app.register(fastifyJwt, {
    secret: options.jwtSecret,
    sign: { expiresIn: options.accessTokenTtl },
  });

  const service = new AuthService({
    prisma: app.prisma,
    google: options.googleVerifier ?? createGoogleVerifier(options.googleClientIds),
    signAccessToken: (payload) => app.jwt.sign(payload),
    accessTokenTtl: options.accessTokenTtl,
    refreshTokenTtlDays: options.refreshTokenTtlDays,
  });

  app.decorate('auth', service);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      // Deliberately opaque: never tell a caller whether the token was
      // malformed, expired or signed with the wrong key.
      throw unauthorized('Missing or invalid access token');
    }
  });
};

export default fp(authPlugin, { name: 'auth', dependencies: ['prisma'] });
