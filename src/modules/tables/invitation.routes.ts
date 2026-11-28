import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TableService } from './table.service.js';
import { invitationIdParamsSchema, redeemInvitationSchema } from './table.schemas.js';
import type { TableRoutesOptions } from './table.routes.js';

/// The in-app half of the invitation flow. The emailed link lands on
/// `invitation-web.routes.ts` when the app is not installed, and only ever
/// renders there: joining always happens here, signed in.
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

  /// The code in a body rather than a path: it is a credential, and paths end
  /// up in access logs.
  app.post(
    '/redeem',
    { schema: { body: redeemInvitationSchema } },
    async (request) => service.redeem(request.user.sub, request.body.code),
  );

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
