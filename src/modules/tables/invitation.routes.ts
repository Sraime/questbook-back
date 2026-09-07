import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TableService } from './table.service.js';
import { invitationIdParamsSchema } from './table.schemas.js';
import type { TableRoutesOptions } from './table.routes.js';

/// The in-app half of the invitation flow. The emailed link is handled by
/// `invitation-web.routes.ts`, which is deliberately unauthenticated.
const invitationRoutes: FastifyPluginAsync<TableRoutesOptions> = async (
  fastify,
  options,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new TableService(app.prisma, app.notifications, app.email, options);

  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => ({
    invitations: await service.listMyInvitations(request.user.sub),
  }));

  app.post(
    '/:id/accept',
    { schema: { params: invitationIdParamsSchema } },
    async (request) =>
      service.respondToInvitation(request.user.sub, request.params.id, true),
  );

  app.post(
    '/:id/decline',
    { schema: { params: invitationIdParamsSchema } },
    async (request, reply) => {
      await service.respondToInvitation(request.user.sub, request.params.id, false);
      return reply.code(204).send();
    },
  );
};

export default invitationRoutes;
