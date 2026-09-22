import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { unauthorized } from '../lib/errors.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { createAppleVerifier } from '../modules/auth/apple-verifier.js';
import type { AppleVerifier } from '../modules/auth/apple-verifier.js';
import { createGoogleVerifier } from '../modules/auth/google-verifier.js';
import type { GoogleVerifier } from '../modules/auth/google-verifier.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
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
  appleClientIds: string[];
  /// Test seams: let integration tests bypass real token verification.
  googleVerifier?: GoogleVerifier;
  appleVerifier?: AppleVerifier;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  await app.register(fastifyJwt, {
    secret: options.jwtSecret,
    sign: { expiresIn: options.accessTokenTtl },
  });

  // Sans audience declaree, aucun jeton Apple ne peut etre accepte. L'API
  // demarre quand meme — la connexion Google n'a pas a tomber avec — mais le
  // dit, plutot que de laisser chercher pourquoi un bouton refuse.
  if (options.appleClientIds.length === 0) {
    app.log.warn('APPLE_CLIENT_IDS is empty: Apple sign-in will refuse every token');
  }

  const service = new AuthService({
    prisma: app.prisma,
    google: options.googleVerifier ?? createGoogleVerifier(options.googleClientIds),
    apple: options.appleVerifier ?? createAppleVerifier(options.appleClientIds),
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
