import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../../lib/errors.js';
import {
  AdminAuthService,
  type AuthenticatedAdmin,
} from '../auth/admin-auth.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    adminAuth: AdminAuthService;
    /// `preHandler` guard: rejects the request unless it carries a live back
    /// office session in `Authorization: Bearer <token>`.
    requireAdmin: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    /// Set by `requireAdmin`, and by nothing else.
    admin?: AuthenticatedAdmin;
  }
}

const adminAuthPlugin: FastifyPluginAsync = async (app) => {
  const service = new AdminAuthService(app.prisma);

  app.decorate('adminAuth', service);

  app.decorateRequest('admin', undefined);

  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

    if (token === null || token.length === 0) {
      throw unauthorized('Session invalide ou expiree');
    }

    // Deliberately the same message as a revoked, expired or unknown token:
    // there is nothing useful to tell a caller who has no session.
    request.admin = await service.authenticate(token);
  });
};

/// The session `requireAdmin` just established. Throwing rather than returning
/// `undefined` keeps every handler from carrying a `!` that says "trust me".
export function currentAdmin(request: FastifyRequest): AuthenticatedAdmin {
  if (request.admin === undefined) {
    throw unauthorized('Session invalide ou expiree');
  }

  return request.admin;
}

export default fp(adminAuthPlugin, { name: 'admin-auth', dependencies: ['prisma'] });
