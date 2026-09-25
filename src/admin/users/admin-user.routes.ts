import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { currentAdmin } from '../plugins/admin-auth.js';
import { AdminUserService } from './admin-user.service.js';
import {
  deleteUserSchema,
  suspendUserSchema,
  userIdParamsSchema,
} from './admin-user.schemas.js';

/// Agir sur un compte. Un signalement qu'on peut lire et classer sans pouvoir
/// agir ne protege personne, et la seule fermeture qui existait jusqu'ici
/// appartenait a l'utilisateur lui-meme.
const adminUserRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new AdminUserService(app.prisma);

  app.addHook('preHandler', app.requireAdmin);

  // Avant `/:id`, sinon `suspended` serait lu comme un identifiant — et
  // rejete par le `uuid()` du schema, ce qui ferait un 400 obscur.
  app.get('/suspended', async () => service.listSuspended());

  app.get('/:id', { schema: { params: userIdParamsSchema } }, async (request) =>
    service.detail(request.params.id),
  );

  app.post(
    '/:id/suspend',
    { schema: { params: userIdParamsSchema, body: suspendUserSchema } },
    async (request) =>
      service.suspend(request.params.id, currentAdmin(request).admin.id, request.body),
  );

  app.delete('/:id/suspend', { schema: { params: userIdParamsSchema } }, async (request) =>
    service.lift(request.params.id, currentAdmin(request).admin.id),
  );

  app.delete(
    '/:id',
    { schema: { params: userIdParamsSchema, body: deleteUserSchema } },
    async (request, reply) => {
      await service.remove(request.params.id, currentAdmin(request).admin.id, request.body);
      return reply.code(204).send();
    },
  );
};

export default adminUserRoutes;
