import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SessionService } from './session.service.js';
import { TableService } from './table.service.js';
import {
  createSessionSchema,
  createTableSchema,
  inviteSchema,
  patchTableSchema,
  tableIdParamsSchema,
  tableInvitationParamsSchema,
  tableMemberParamsSchema,
  transferGameMasterSchema,
} from './table.schemas.js';

export interface TableRoutesOptions {
  publicBaseUrl: string;
  invitationTtlDays: number;
}

const tableRoutes: FastifyPluginAsync<TableRoutesOptions> = async (
  fastify,
  options,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new TableService(app.prisma, app.notifications, app.email, options);
  const sessions = new SessionService(app.prisma, app.notifications);

  // Every route below is member-only, no exceptions.
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => ({ tables: await service.list(request.user.sub) }));

  app.post(
    '/',
    { schema: { body: createTableSchema } },
    async (request, reply) => {
      const table = await service.create(request.user.sub, request.body);
      return reply.code(201).send(table);
    },
  );

  app.get(
    '/:id',
    { schema: { params: tableIdParamsSchema } },
    async (request) => service.get(request.user.sub, request.params.id),
  );

  app.patch(
    '/:id',
    { schema: { params: tableIdParamsSchema, body: patchTableSchema } },
    async (request) => service.patch(request.user.sub, request.params.id, request.body),
  );

  app.delete(
    '/:id',
    { schema: { params: tableIdParamsSchema } },
    async (request, reply) => {
      await service.remove(request.user.sub, request.params.id);
      return reply.code(204).send();
    },
  );

  // --- Members ---

  app.delete(
    '/:id/members/me',
    { schema: { params: tableIdParamsSchema } },
    async (request, reply) => {
      await service.leave(request.user.sub, request.params.id);
      return reply.code(204).send();
    },
  );

  /// A PUT rather than a POST: a table has one game master, and this sets who
  /// it is. Sending it twice changes nothing the second time.
  app.put(
    '/:id/game-master',
    { schema: { params: tableIdParamsSchema, body: transferGameMasterSchema } },
    async (request) =>
      service.transferGameMaster(
        request.user.sub,
        request.params.id,
        request.body.userId,
      ),
  );

  app.delete(
    '/:id/members/:userId',
    { schema: { params: tableMemberParamsSchema } },
    async (request, reply) => {
      await service.removeMember(
        request.user.sub,
        request.params.id,
        request.params.userId,
      );
      return reply.code(204).send();
    },
  );

  // --- Invitations ---

  app.post(
    '/:id/invitations',
    { schema: { params: tableIdParamsSchema, body: inviteSchema } },
    async (request, reply) => {
      const invitation = await service.invite(
        request.user.sub,
        request.params.id,
        request.body,
      );
      return reply.code(201).send(invitation);
    },
  );

  app.delete(
    '/:id/invitations/:invitationId',
    { schema: { params: tableInvitationParamsSchema } },
    async (request, reply) => {
      await service.revokeInvitation(
        request.user.sub,
        request.params.id,
        request.params.invitationId,
      );
      return reply.code(204).send();
    },
  );

  // --- Sessions ---

  app.get(
    '/:id/sessions',
    { schema: { params: tableIdParamsSchema } },
    async (request) => ({
      sessions: await sessions.list(request.user.sub, request.params.id),
    }),
  );

  app.post(
    '/:id/sessions',
    { schema: { params: tableIdParamsSchema, body: createSessionSchema } },
    async (request, reply) => {
      const session = await sessions.create(
        request.user.sub,
        request.params.id,
        request.body,
      );
      return reply.code(201).send(session);
    },
  );
};

export default tableRoutes;
